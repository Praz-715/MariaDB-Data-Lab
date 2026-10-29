// Static reference data used by the generator. Geography uses real Brazilian
// states and cities (public geographic facts) with approximate coordinates and
// postal-code prefixes inside each state's real CEP range. All people, sellers,
// carriers and brands are fictional.

export const STATES = {
  AC: ['Acre', 'North'], AL: ['Alagoas', 'Northeast'], AP: ['Amapá', 'North'], AM: ['Amazonas', 'North'],
  BA: ['Bahia', 'Northeast'], CE: ['Ceará', 'Northeast'], DF: ['Distrito Federal', 'Central-West'],
  ES: ['Espírito Santo', 'Southeast'], GO: ['Goiás', 'Central-West'], MA: ['Maranhão', 'Northeast'],
  MT: ['Mato Grosso', 'Central-West'], MS: ['Mato Grosso do Sul', 'Central-West'], MG: ['Minas Gerais', 'Southeast'],
  PA: ['Pará', 'North'], PB: ['Paraíba', 'Northeast'], PR: ['Paraná', 'South'], PE: ['Pernambuco', 'Northeast'],
  PI: ['Piauí', 'Northeast'], RJ: ['Rio de Janeiro', 'Southeast'], RN: ['Rio Grande do Norte', 'Northeast'],
  RS: ['Rio Grande do Sul', 'South'], RO: ['Rondônia', 'North'], RR: ['Roraima', 'North'],
  SC: ['Santa Catarina', 'South'], SP: ['São Paulo', 'Southeast'], SE: ['Sergipe', 'Northeast'], TO: ['Tocantins', 'North'],
};

// [state, city, lat, lng, first CEP prefix, customer weight, seller weight]
export const CITIES = [
  ['SP', 'São Paulo', -23.5505, -46.6333, 1001, 120, 220],
  ['SP', 'Guarulhos', -23.4538, -46.5333, 7010, 13, 18],
  ['SP', 'Campinas', -22.9056, -47.0608, 13010, 12, 30],
  ['SP', 'São José dos Campos', -23.1791, -45.8872, 12210, 7, 10],
  ['SP', 'Ribeirão Preto', -21.1775, -47.8103, 14010, 7, 12],
  ['SP', 'Sorocaba', -23.5015, -47.4526, 18010, 7, 10],
  ['SP', 'Santos', -23.9608, -46.3336, 11010, 5, 6],
  ['RJ', 'Rio de Janeiro', -22.9068, -43.1729, 20010, 65, 40],
  ['RJ', 'Niterói', -22.8832, -43.1034, 24020, 5, 4],
  ['RJ', 'Duque de Caxias', -22.7856, -43.3117, 25010, 9, 3],
  ['RJ', 'Nova Iguaçu', -22.7556, -43.4603, 26010, 8, 2],
  ['RJ', 'Petrópolis', -22.5050, -43.1786, 25610, 3, 2],
  ['MG', 'Belo Horizonte', -19.9167, -43.9345, 30110, 25, 28],
  ['MG', 'Uberlândia', -18.9186, -48.2772, 38400, 7, 6],
  ['MG', 'Juiz de Fora', -21.7642, -43.3496, 36010, 6, 4],
  ['MG', 'Contagem', -19.9320, -44.0539, 32010, 6, 5],
  ['MG', 'Montes Claros', -16.7350, -43.8619, 39400, 4, 1],
  ['ES', 'Vitória', -20.3155, -40.3128, 29010, 4, 3],
  ['ES', 'Vila Velha', -20.3297, -40.2925, 29100, 5, 2],
  ['PR', 'Curitiba', -25.4284, -49.2733, 80010, 19, 30],
  ['PR', 'Londrina', -23.3045, -51.1696, 86010, 6, 7],
  ['PR', 'Maringá', -23.4205, -51.9333, 87010, 4, 8],
  ['SC', 'Florianópolis', -27.5954, -48.5480, 88010, 5, 8],
  ['SC', 'Joinville', -26.3045, -48.8487, 89201, 6, 9],
  ['SC', 'Blumenau', -26.9194, -49.0661, 89010, 4, 9],
  ['RS', 'Porto Alegre', -30.0346, -51.2177, 90010, 15, 18],
  ['RS', 'Caxias do Sul', -29.1678, -51.1794, 95010, 5, 6],
  ['RS', 'Pelotas', -31.7654, -52.3376, 96010, 3, 1],
  ['DF', 'Brasília', -15.7939, -47.8828, 70040, 30, 10],
  ['GO', 'Goiânia', -16.6869, -49.2648, 74003, 15, 8],
  ['GO', 'Anápolis', -16.3281, -48.9534, 75020, 4, 2],
  ['MT', 'Cuiabá', -15.6014, -56.0979, 78005, 6, 2],
  ['MS', 'Campo Grande', -20.4697, -54.6201, 79002, 9, 2],
  ['BA', 'Salvador', -12.9714, -38.5014, 40010, 25, 6],
  ['BA', 'Feira de Santana', -12.2664, -38.9663, 44001, 6, 1],
  ['BA', 'Vitória da Conquista', -14.8615, -40.8442, 45000, 3, 1],
  ['PE', 'Recife', -8.0476, -34.8770, 50010, 16, 5],
  ['PE', 'Jaboatão dos Guararapes', -8.1130, -35.0156, 54000, 7, 1],
  ['PE', 'Caruaru', -8.2760, -35.9819, 55002, 3, 1],
  ['CE', 'Fortaleza', -3.7319, -38.5267, 60010, 26, 4],
  ['CE', 'Juazeiro do Norte', -7.2131, -39.3151, 63010, 3, 1],
  ['PA', 'Belém', -1.4558, -48.4902, 66010, 14, 1],
  ['PA', 'Santarém', -2.4430, -54.7082, 68005, 3, 0.3],
  ['AM', 'Manaus', -3.1190, -60.0217, 69005, 21, 1],
  ['MA', 'São Luís', -2.5307, -44.3068, 65010, 10, 1],
  ['PB', 'João Pessoa', -7.1195, -34.8450, 58010, 8, 1],
  ['RN', 'Natal', -5.7945, -35.2110, 59010, 8, 1],
  ['AL', 'Maceió', -9.6658, -35.7353, 57010, 9, 1],
  ['SE', 'Aracaju', -10.9472, -37.0731, 49010, 6, 0.5],
  ['PI', 'Teresina', -5.0920, -42.8038, 64000, 8, 0.5],
  ['TO', 'Palmas', -10.2491, -48.3243, 77001, 3, 0.3],
  ['RO', 'Porto Velho', -8.7612, -63.9004, 76801, 5, 0.3],
  ['AC', 'Rio Branco', -9.9754, -67.8249, 69900, 4, 0.2],
  ['AP', 'Macapá', 0.0349, -51.0694, 68900, 4, 0.2],
  ['RR', 'Boa Vista', 2.8235, -60.6758, 69301, 4, 0.2],
];

// Expands cities into postal-prefix level locations. Larger cities get more
// prefixes; location ids are stable because the list order is fixed.
export function buildLocations() {
  const locations = [];
  for (const [state, city, lat, lng, zipBase, customerWeight, sellerWeight] of CITIES) {
    const [stateName, region] = STATES[state];
    const n = Math.max(1, Math.min(12, Math.round(customerWeight / 4)));
    for (let k = 0; k < n; k++) {
      // Deterministic jitter so prefixes of one city spread over a few km.
      const jLat = (((k * 37) % 11) - 5) * 0.006;
      const jLng = (((k * 53) % 13) - 6) * 0.006;
      locations.push({
        locationId: locations.length + 1,
        zipPrefix: String(zipBase + k * 7).padStart(5, '0'),
        city,
        state,
        stateName,
        region,
        lat: +(lat + jLat).toFixed(6),
        lng: +(lng + jLng).toFixed(6),
        customerWeight: customerWeight / n,
        sellerWeight: sellerWeight / n,
      });
    }
  }
  return locations;
}

export const CURRENCIES = [
  ['BRL', 'Brazilian real', 'R$', 2, 1],
  ['USD', 'US dollar', 'US$', 2, 5.42],
  ['EUR', 'Euro', '€', 2, 5.91],
  ['ARS', 'Argentine peso', 'AR$', 2, 0.0058],
];

export const SEGMENTS = [
  [1, 'new', 'New', 'Registered during the last 90 days of the history window'],
  [2, 'occasional', 'Occasional', 'Buys rarely; most of the customer base'],
  [3, 'regular', 'Regular', 'Buys several times per year'],
  [4, 'loyal', 'Loyal', 'Frequent repeat buyer'],
  [5, 'vip', 'VIP', 'Top 1% customers by purchase propensity'],
];

// [id, code, name, service level, base rate BRL, per-kg BRL, median transit days]
export const CARRIERS = [
  [1, 'ECONOLOG', 'EconoLog Transportes (fictional)', 'economy', 9.9, 2.4, 7.5],
  [2, 'SWIFTBR', 'SwiftBR Express (fictional)', 'express', 16.9, 3.6, 3.2],
  [3, 'NORTEVIA', 'NorteVia Cargas (fictional)', 'standard', 12.5, 3.0, 6.0],
  [4, 'SULTRANS', 'SulTrans Logística (fictional)', 'standard', 11.9, 2.8, 4.5],
  [5, 'METROCOUR', 'MetroCourier Urbano (fictional)', 'same_day', 14.0, 4.5, 1.0],
];

// [id, code, name, city, state, capacity, opened]
export const WAREHOUSES = [
  [1, 'WH-SP-GRU', 'Fulfillment Center Guarulhos', 'Guarulhos', 'SP', 900000, '2016-03-01'],
  [2, 'WH-SP-CPQ', 'Fulfillment Center Campinas', 'Campinas', 'SP', 600000, '2017-08-15'],
  [3, 'WH-RJ-RIO', 'Fulfillment Center Rio de Janeiro', 'Rio de Janeiro', 'RJ', 450000, '2017-02-01'],
  [4, 'WH-MG-BHZ', 'Fulfillment Center Belo Horizonte', 'Belo Horizonte', 'MG', 350000, '2018-05-10'],
  [5, 'WH-PR-CWB', 'Fulfillment Center Curitiba', 'Curitiba', 'PR', 300000, '2018-01-20'],
  [6, 'WH-RS-POA', 'Fulfillment Center Porto Alegre', 'Porto Alegre', 'RS', 250000, '2019-04-01'],
  [7, 'WH-DF-BSB', 'Fulfillment Center Brasília', 'Brasília', 'DF', 220000, '2019-09-01'],
  [8, 'WH-BA-SSA', 'Fulfillment Center Salvador', 'Salvador', 'BA', 200000, '2020-02-15'],
  [9, 'WH-PE-REC', 'Fulfillment Center Recife', 'Recife', 'PE', 200000, '2020-06-01'],
  [10, 'WH-CE-FOR', 'Fulfillment Center Fortaleza', 'Fortaleza', 'CE', 150000, '2021-03-01'],
  [11, 'WH-AM-MAO', 'Fulfillment Center Manaus', 'Manaus', 'AM', 120000, '2021-10-01'],
  [12, 'WH-GO-GYN', 'Fulfillment Center Goiânia', 'Goiânia', 'GO', 160000, '2020-11-01'],
];

export const CATEGORY_PARENTS = [
  ['home_living', 'Home & Living'],
  ['health_beauty_group', 'Health & Beauty'],
  ['sports_leisure_group', 'Sports & Leisure'],
  ['electronics_group', 'Electronics & Computers'],
  ['fashion_group', 'Fashion & Accessories'],
  ['kids_baby', 'Toys & Baby'],
  ['auto_tools', 'Auto & Tools'],
  ['books_media', 'Books & Media'],
  ['food_drink', 'Food & Drink'],
  ['pets', 'Pets'],
  ['office_art', 'Office, Art & Party'],
];

// [code, name, parent, share weight, median price BRL, price sigma, median weight g, nouns, attribute set]
export const CATEGORY_LEAVES = [
  ['bed_bath_table', 'Bed, Bath & Table', 'home_living', 11.0, 89, 0.55, 1500, ['Towel Set', 'Bed Sheet Set', 'Duvet', 'Pillow', 'Tablecloth', 'Bath Mat'], 'textile'],
  ['health_beauty', 'Health & Beauty', 'health_beauty_group', 9.6, 105, 0.7, 450, ['Moisturizer', 'Hair Dryer', 'Shampoo Kit', 'Facial Serum', 'Electric Toothbrush'], 'beauty'],
  ['sports_leisure', 'Sports & Leisure', 'sports_leisure_group', 8.6, 99, 0.75, 1200, ['Yoga Mat', 'Dumbbell Pair', 'Bike Helmet', 'Running Belt', 'Camping Lantern'], 'sport'],
  ['furniture_decor', 'Furniture & Decor', 'home_living', 8.3, 85, 0.7, 2600, ['Wall Clock', 'Picture Frame', 'Floor Lamp', 'Decorative Vase', 'Shelf'], 'home'],
  ['computers_accessories', 'Computer Accessories', 'electronics_group', 7.8, 115, 0.8, 500, ['Wireless Mouse', 'Keyboard', 'USB Hub', 'Laptop Stand', 'Webcam'], 'electronic'],
  ['housewares', 'Housewares', 'home_living', 6.9, 88, 0.7, 1700, ['Cookware Set', 'Knife Block', 'Storage Jars', 'Blender', 'Dish Rack'], 'home'],
  ['watches_gifts', 'Watches & Gifts', 'fashion_group', 5.9, 175, 0.8, 350, ['Wristwatch', 'Gift Box', 'Pocket Watch', 'Jewelry Box'], 'fashion'],
  ['telephony', 'Telephony', 'electronics_group', 4.4, 49, 0.9, 220, ['Phone Case', 'Charger', 'Screen Protector', 'Earphones', 'Car Mount'], 'electronic'],
  ['garden_tools', 'Garden Tools', 'home_living', 3.9, 99, 0.7, 2400, ['Garden Hose', 'Pruning Shears', 'Planter', 'Sprinkler'], 'tool'],
  ['auto', 'Automotive', 'auto_tools', 3.8, 110, 0.85, 1300, ['Car Cover', 'Seat Organizer', 'Tire Inflator', 'Dash Cam'], 'tool'],
  ['toys', 'Toys', 'kids_baby', 3.6, 89, 0.75, 900, ['Building Blocks', 'Puzzle', 'Plush Toy', 'RC Car', 'Board Game'], 'kids'],
  ['cool_stuff', 'Cool Stuff', 'sports_leisure_group', 3.4, 150, 0.8, 1500, ['Gadget Kit', 'Novelty Lamp', 'Retro Radio'], 'home'],
  ['perfumery', 'Perfumery', 'health_beauty_group', 3.0, 110, 0.7, 380, ['Eau de Parfum', 'Body Splash', 'Cologne'], 'beauty'],
  ['baby', 'Baby', 'kids_baby', 2.7, 115, 0.75, 1600, ['Baby Monitor', 'Stroller Organizer', 'Crib Mobile', 'Feeding Set'], 'kids'],
  ['electronics', 'Electronics', 'electronics_group', 2.5, 59, 0.9, 350, ['Power Bank', 'Smart Plug', 'Bluetooth Speaker', 'LED Strip'], 'electronic'],
  ['stationery', 'Stationery', 'office_art', 2.2, 69, 0.8, 600, ['Notebook Set', 'Pen Kit', 'Planner', 'Desk Organizer'], 'office'],
  ['fashion_bags_accessories', 'Bags & Accessories', 'fashion_group', 1.8, 69, 0.8, 500, ['Backpack', 'Wallet', 'Belt', 'Sunglasses'], 'fashion'],
  ['pet_shop', 'Pet Shop', 'pets', 1.7, 99, 0.75, 1800, ['Pet Bed', 'Leash', 'Feeder', 'Scratching Post'], 'pet'],
  ['office_furniture', 'Office Furniture', 'home_living', 1.5, 160, 0.6, 9000, ['Office Chair', 'Desk', 'Filing Cabinet'], 'home'],
  ['consoles_games', 'Consoles & Games', 'electronics_group', 1.0, 120, 0.9, 700, ['Game Controller', 'Gaming Headset', 'Console Stand'], 'electronic'],
  ['luggage_accessories', 'Luggage', 'fashion_group', 1.0, 150, 0.65, 3200, ['Carry-on Suitcase', 'Travel Organizer', 'Duffel Bag'], 'fashion'],
  ['construction_tools', 'Construction Tools', 'auto_tools', 0.8, 130, 0.8, 2500, ['Power Drill', 'Tool Set', 'Laser Level'], 'tool'],
  ['home_appliances', 'Home Appliances', 'home_living', 0.7, 220, 0.75, 5200, ['Air Fryer', 'Vacuum Cleaner', 'Coffee Maker', 'Fan'], 'appliance'],
  ['musical_instruments', 'Musical Instruments', 'sports_leisure_group', 0.6, 230, 0.9, 2800, ['Acoustic Guitar', 'Keyboard Stand', 'Ukulele'], 'sport'],
  ['home_construction', 'Home Construction', 'auto_tools', 0.5, 120, 0.8, 3500, ['Faucet', 'Shower Head', 'Door Handle Set'], 'tool'],
  ['books_general', 'Books', 'books_media', 0.5, 49, 0.55, 450, ['Novel', 'Cookbook', 'Biography'], 'book'],
  ['food', 'Food', 'food_drink', 0.4, 45, 0.6, 900, ['Coffee Beans', 'Granola Pack', 'Spice Kit'], 'food'],
  ['furniture_living_room', 'Living Room Furniture', 'home_living', 0.4, 180, 0.7, 12000, ['Coffee Table', 'TV Rack', 'Armchair'], 'home'],
  ['drinks', 'Drinks', 'food_drink', 0.3, 50, 0.6, 1400, ['Tea Selection', 'Juice Pack', 'Craft Soda Box'], 'food'],
  ['audio', 'Audio', 'electronics_group', 0.3, 130, 0.85, 800, ['Headphones', 'Soundbar', 'Turntable'], 'electronic'],
  ['fashion_shoes', 'Shoes', 'fashion_group', 0.25, 100, 0.6, 900, ['Sneakers', 'Sandals', 'Boots'], 'fashion'],
  ['books_technical', 'Technical Books', 'books_media', 0.2, 75, 0.5, 700, ['Engineering Handbook', 'Programming Guide'], 'book'],
  ['art', 'Art Supplies', 'office_art', 0.2, 90, 0.7, 800, ['Paint Set', 'Canvas Pack', 'Brush Set'], 'office'],
  ['tablets_printing_image', 'Tablets & Printing', 'electronics_group', 0.1, 300, 0.7, 900, ['Tablet Case', 'Photo Printer', 'Stylus'], 'electronic'],
  ['diapers_and_hygiene', 'Diapers & Hygiene', 'health_beauty_group', 0.1, 40, 0.5, 2000, ['Diaper Pack', 'Wet Wipes Box'], 'beauty'],
  ['party_supplies', 'Party Supplies', 'office_art', 0.1, 40, 0.7, 600, ['Balloon Kit', 'Party Decor Set'], 'office'],
  ['music', 'Music & Media', 'books_media', 0.1, 50, 0.6, 250, ['Vinyl Record', 'CD Box Set'], 'book'],
  ['fashion_male_clothing', 'Men\'s Clothing', 'fashion_group', 0.1, 80, 0.6, 400, ['Polo Shirt', 'Jacket', 'Jeans'], 'fashion'],
];

export const CATEGORY_VARIANTS = ['Premium', 'Essentials', 'Outlet', 'Pro', 'Kids', 'Eco', 'Classic', 'Compact', 'Travel', 'Smart'];

export const ATTRIBUTE_SETS = {
  textile: { material: ['Cotton', 'Microfiber', 'Linen', 'Percale'], color: 'colors', size: ['Single', 'Double', 'Queen', 'King'] },
  beauty: { volume_ml: ['50', '100', '200', '250'], skin_type: ['All', 'Dry', 'Oily', 'Sensitive'], vegan: ['yes', 'no'] },
  sport: { material: ['EVA', 'Steel', 'Nylon', 'Neoprene'], color: 'colors', level: ['Beginner', 'Intermediate', 'Advanced'] },
  home: { material: ['Wood', 'Metal', 'Glass', 'Ceramic', 'MDF'], color: 'colors', style: ['Modern', 'Rustic', 'Industrial', 'Scandinavian'] },
  electronic: { brand: 'brands', color: 'colors', warranty_months: ['3', '6', '12', '24'], voltage: ['bivolt', '110V', '220V'] },
  fashion: { material: ['Leather', 'Synthetic', 'Canvas', 'Stainless Steel'], color: 'colors', gender: ['Unisex', 'Women', 'Men'] },
  tool: { brand: 'brands', warranty_months: ['6', '12', '24'], power_source: ['Manual', 'Electric', 'Battery'] },
  kids: { age_range: ['0-2', '3-5', '6-8', '9-12'], material: ['Plastic', 'Wood', 'Plush', 'Silicone'], certified: ['yes'] },
  pet: { pet_type: ['Dog', 'Cat', 'Small pets'], size: ['S', 'M', 'L'], color: 'colors' },
  office: { color: 'colors', pack_size: ['1', '3', '6', '12'], material: ['Paper', 'Plastic', 'Metal'] },
  appliance: { brand: 'brands', voltage: ['110V', '220V'], warranty_months: ['12', '24'], energy_rating: ['A', 'B', 'C'] },
  book: { language: ['Portuguese', 'English', 'Spanish'], format: ['Paperback', 'Hardcover'], pages: ['120', '240', '360', '480'] },
  food: { weight_g: ['250', '500', '1000'], organic: ['yes', 'no'], shelf_life_days: ['90', '180', '365'] },
};

export const COLORS = ['Black', 'White', 'Gray', 'Navy', 'Beige', 'Red', 'Green', 'Blue', 'Pink', 'Brown'];
export const BRANDS = ['Aurora Labs', 'Norvia', 'Pindorama', 'Solaris Home', 'Tupã Tech', 'Vela', 'Ipê', 'Cobalto', 'Maré', 'Jatobá'];
export const ADJECTIVES = ['Classic', 'Premium', 'Compact', 'Deluxe', 'Essential', 'Ergonomic', 'Portable', 'Smart', 'Eco', 'Pro', 'Soft', 'Urban'];

// Common Brazilian given names and surnames, combined randomly: the resulting
// people are fictional.
export const FIRST_NAMES = [
  'Ana', 'Beatriz', 'Camila', 'Daniela', 'Eduarda', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Juliana', 'Larissa', 'Mariana',
  'Natália', 'Patrícia', 'Rafaela', 'Sofia', 'Tatiana', 'Vitória', 'Yasmin', 'Luana', 'Clara', 'Lívia', 'Alice', 'Bianca',
  'André', 'Bruno', 'Carlos', 'Diego', 'Eduardo', 'Felipe', 'Gabriel', 'Gustavo', 'Henrique', 'Igor', 'João', 'Lucas',
  'Marcelo', 'Mateus', 'Nicolas', 'Otávio', 'Paulo', 'Rafael', 'Rodrigo', 'Samuel', 'Thiago', 'Vinícius', 'Wagner', 'Caio',
];
export const LAST_NAMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro',
  'Martins', 'Carvalho', 'Almeida', 'Lopes', 'Soares', 'Fernandes', 'Vieira', 'Barbosa', 'Rocha', 'Dias', 'Nascimento',
  'Andrade', 'Moreira', 'Nunes', 'Marques', 'Machado', 'Mendes', 'Freitas', 'Cardoso', 'Ramos', 'Teixeira', 'Araújo',
];
export const STREET_TYPES = ['Rua', 'Avenida', 'Travessa', 'Alameda', 'Praça'];
export const STREET_NAMES = [
  'das Acácias', 'dos Ipês', 'das Palmeiras', 'Sete de Setembro', 'XV de Novembro', 'da Liberdade', 'das Flores',
  'do Comércio', 'Santos Dumont', 'Tiradentes', 'da Independência', 'dos Andradas', 'Marechal Deodoro', 'da Paz',
  'Boa Vista', 'das Gaivotas', 'do Sol', 'Primavera', 'dos Pinheiros', 'das Mangueiras', 'Monte Alegre', 'Bela Vista',
];
export const DISTRICTS = ['Centro', 'Jardim América', 'Vila Nova', 'Santa Cecília', 'Boa Viagem', 'Bela Vista', 'Jardim Europa', 'Parque das Nações', 'Alto da Glória', 'Vila Mariana', 'Industrial', 'São José'];
export const SELLER_WORDS = ['Casa', 'Loja', 'Empório', 'Ateliê', 'Mundo', 'Ponto', 'Bazar', 'Oficina', 'Estação', 'Armazém'];
export const SELLER_NAMES = ['Aurora', 'Bela Vista', 'Horizonte', 'Ipê Roxo', 'Girassol', 'Maré Alta', 'Serra Azul', 'Sabiá', 'Jardim', 'Cacau', 'Cerrado', 'Lua Nova', 'Canela', 'Pitanga'];

export const REVIEW_TITLES = {
  5: ['Excellent product', 'Exceeded expectations', 'Perfect, recommend it', 'Arrived early and works great'],
  4: ['Very good', 'Good value for money', 'Happy with the purchase'],
  3: ['It is okay', 'Average quality', 'As expected, nothing special'],
  2: ['Disappointed', 'Quality could be better', 'Took too long to arrive'],
  1: ['Terrible experience', 'Product did not arrive in time', 'Not as described', 'Arrived damaged'],
};
export const REVIEW_COMMENTS = {
  5: ['Great finish and well packaged.', 'Delivered before the estimated date.', 'Exactly as in the pictures.'],
  4: ['Good product, packaging could be better.', 'Works well, delivery was on time.'],
  3: ['Does the job but feels cheap.', 'Fine for the price.'],
  2: ['Smaller than I expected.', 'Delivery was late and support was slow.'],
  1: ['Still waiting for a refund.', 'Came broken and with missing parts.', 'Very late delivery.'],
};
