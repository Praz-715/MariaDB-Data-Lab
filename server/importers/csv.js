// Streaming RFC 4180 CSV parser. Reads a byte stream chunk by chunk and yields
// one record at a time, so memory use is bounded by the largest record, never by
// the file. Handles quoted fields, escaped quotes (""), delimiters and line breaks
// inside quotes, CRLF/LF/CR line endings, a UTF-8 BOM, and multi-byte characters
// split across chunks. Malformed input is reported per record instead of
// aborting the whole file.
import { StringDecoder } from 'node:string_decoder';

const QUOTE = 34;
const LF = 10;
const CR = 13;

export async function* parseCsv(input, { delimiter = ',', maxFieldLength = 100_000, maxFields = 500 } = {}) {
  const delim = delimiter.charCodeAt(0);
  const decoder = new StringDecoder('utf8');
  let fields = [];
  let field = '';
  let inQuotes = false;
  let quotePending = false; // saw a quote inside a quoted field; next char decides
  let afterQuote = false; // closing quote seen; only a delimiter or line break may follow
  let error = null;
  let record = 0;
  let bytes = 0;
  let first = true;
  let skipLf = false;
  let overflow = false; // current field already exceeded maxFieldLength

  // Appends to the current field but never beyond maxFieldLength + 1 characters,
  // so an unterminated quote or a file without line breaks cannot grow memory.
  function append(str) {
    if (overflow) return;
    if (field.length + str.length > maxFieldLength) {
      field += str.slice(0, maxFieldLength + 1 - field.length);
      overflow = true;
      if (!error) error = `field longer than ${maxFieldLength} characters`;
    } else {
      field += str;
    }
  }

  function pushField() {
    if (field.length > maxFieldLength && !error) error = `field longer than ${maxFieldLength} characters`;
    if (fields.length >= maxFields) {
      if (!error) error = `more than ${maxFields} fields`;
    } else {
      fields.push(field);
    }
    field = '';
    overflow = false;
    afterQuote = false;
  }

  function endRecord() {
    pushField();
    const out = { fields, error, record: ++record, bytes };
    fields = [];
    error = null;
    return out;
  }

  const isBlank = () => fields.length === 0 && field === '' && !afterQuote;

  for await (const chunk of input) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bytes += buf.length;
    let text = decoder.write(buf);
    if (first && text.length) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    const out = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (skipLf) {
        skipLf = false;
        if (c === LF) {
          i++;
          continue;
        }
      }
      if (inQuotes) {
        if (quotePending) {
          quotePending = false;
          if (c === QUOTE) {
            append('"');
            i++;
            continue;
          }
          inQuotes = false;
          afterQuote = true;
          continue; // re-examine c outside quotes
        }
        // Copy a run of ordinary characters at once.
        const q = text.indexOf('"', i);
        if (q === -1) {
          append(text.slice(i));
          i = n;
        } else {
          append(text.slice(i, q));
          quotePending = true;
          i = q + 1;
        }
        continue;
      }
      if (c === delim) {
        pushField();
        i++;
      } else if (c === LF || c === CR) {
        if (!isBlank()) out.push(endRecord());
        else fields = [];
        if (c === CR) skipLf = true;
        i++;
      } else if (c === QUOTE && field === '' && !afterQuote) {
        inQuotes = true;
        i++;
      } else {
        if (afterQuote && !error) error = 'unexpected character after closing quote';
        // Copy a run of ordinary unquoted characters at once.
        let j = i + 1;
        while (j < n) {
          const d = text.charCodeAt(j);
          if (d === delim || d === LF || d === CR) break;
          j++;
        }
        append(text.slice(i, j));
        i = j;
      }
    }
    for (const rec of out) yield rec;
  }
  const tail = decoder.end();
  if (tail) append(tail);
  if (quotePending) {
    inQuotes = false;
    afterQuote = true;
  }
  if (inQuotes) {
    if (!error) error = 'unterminated quoted field at end of file';
    yield endRecord();
  } else if (!isBlank()) {
    yield endRecord();
  }
}

// Convenience for tests and previews: parse a string or buffer completely.
export async function parseCsvText(text, opts) {
  const out = [];
  for await (const rec of parseCsv([Buffer.from(text)], opts)) out.push(rec);
  return out;
}
