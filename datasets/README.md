# Reference datasets

No dataset is bundled with this repository, and the application never downloads one.

## Primary reference: Brazilian E-Commerce Public Dataset by Olist

- Source: <https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce>
- Licence: check the licence shown on the Kaggle page before use. At the time of writing it is listed as
  CC BY-NC-SA 4.0, which restricts commercial use and requires attribution. Do not redistribute the files.
- Download it yourself (a Kaggle account is required) and place the CSV files in `datasets/raw/`, which is
  git-ignored.

## Using it

1. Put the nine CSV files in `datasets/raw/` (or the directory in `DATASET_DIR`), or upload them on the
   **Dataset Sources** page. Only the nine known file names are accepted.
2. **Dataset Sources → Scan all files**: SHA-256, record counts, header check and a dry-run validation of every
   record. **Preview** shows the column mapping and the first rows with per-field validation.
3. **Import Manager → Stage CSV files**: confirm the licence and import. Files are streamed into the `stg_olist_*`
   tables in resumable units; invalid records are counted by reason and sampled into `stg_import_rejects`.
4. Review the **staging integrity** report (cross-file references, duplicates, inconsistent timestamps).
5. **Transform into lab tables**: Olist records become lab rows; attributes Olist does not have are synthesized,
   and every repair is counted (see the README section "Olist import").
6. Optionally **compute a calibration profile** and generate a larger synthetic dataset with the same
   distributions on the Data Generator page.

## Trying it without the real data

```sh
node scripts/make-olist-fixture.js datasets/raw 3000
```

writes a small **synthetic** file set in the Olist layout, including the quirks of the real files (quoted values,
BOM, multi-line comments, inconsistent timestamps, payments that do not add up, malformed rows). It contains no
Olist data. Delete it before copying in the real files.

## Built-in generator model

Without a calibration profile, the generator uses built-in distributions modelled on the published shape of the
dataset: category popularity and price levels, payment mix (credit card about 74%, boleto about 19%), delivery
times around 12 days, review scores, and customer concentration in São Paulo, Rio de Janeiro and Minas Gerais.
All people, sellers, carriers and brands are fictional.
