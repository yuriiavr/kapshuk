// Категорії витрат (за типом магазину) і групи товарів із чеків. Спільне для сервера й інтерфейсу — без імпортів.

export const CATEGORIES = {
  groceries: { title: 'Продукти', color: '#3DD68C' },
  cafe: { title: 'Кафе й доставка', color: '#F2A93B' },
  transport: { title: 'Транспорт і таксі', color: '#4C9AFF' },
  health: { title: "Здоров'я й аптеки", color: '#FF7A9A' },
  beauty: { title: 'Краса й догляд', color: '#E58CFF' },
  clothes: { title: 'Одяг і взуття', color: '#B28CFF' },
  home: { title: 'Дім і побут', color: '#5CC8D6' },
  utilities: { title: "Комуналка й зв'язок", color: '#6E9BFF' },
  digital: { title: 'Підписки й цифрове', color: '#8C9EFF' },
  fun: { title: 'Розваги й спорт', color: '#FFC857' },
  kids: { title: 'Діти й освіта', color: '#FF9F6B' },
  pets: { title: 'Тварини', color: '#C2A878' },
  alcohol: { title: 'Алкоголь і тютюн', color: '#D9636B' },
  tech: { title: 'Техніка', color: '#7FB3D5' },
  travel: { title: 'Подорожі', color: '#4DD0A8' },
  gov: { title: 'Держава й податки', color: '#C9B26B' },
  finance: { title: 'Кредити й страхування', color: '#8FA3BF' },
  transfers: { title: 'Перекази людям', color: '#E6E7EA' },
  cash: { title: 'Готівка', color: '#A3D46A' },
  other: { title: 'Інше', color: '#6F737A' },
} as const;
export type Category = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];
export const isCategory = (c: unknown): c is Category => typeof c === 'string' && c in CATEGORIES;

// Групи товарів: щоб у кінці місяця бачити, на що саме пішли гроші в магазинах
export const ITEM_GROUPS = {
  veg_fruit: 'Овочі й фрукти',
  meat_fish: "М'ясо й риба",
  dairy: 'Молочне й яйця',
  bread: 'Хліб і випічка',
  grocery: 'Бакалія',
  ready_food: 'Готова їжа',
  sweets: 'Солодощі й снеки',
  drinks: 'Напої',
  coffee_tea: 'Кава й чай',
  alcohol: 'Алкоголь і тютюн',
  household: 'Побутова хімія й дім',
  hygiene: 'Гігієна й косметика',
  pharmacy: 'Ліки й аптека',
  kids: 'Дитяче',
  pets: 'Тваринам',
  clothes: 'Одяг і взуття',
  tech: 'Техніка',
  dishes: 'Страви в кафе',
  services: 'Послуги',
  other: 'Інше',
} as const;
export type ItemGroup = keyof typeof ITEM_GROUPS;
export const ITEM_GROUP_KEYS = Object.keys(ITEM_GROUPS) as ItemGroup[];
export const isItemGroup = (g: unknown): g is ItemGroup => typeof g === 'string' && g in ITEM_GROUPS;

// Тип магазину (MCC) → категорія. Чого тут немає — «Інше»
const MCC: Partial<Record<Category, (number | [number, number])[]>> = {
  groceries: [5297, 5300, 5411, 5422, 5441, 5451, 5462, 5499],
  cafe: [5811, 5812, 5813, 5814],
  transport: [4011, 4111, 4112, 4121, 4131, 4784, 4789, 5511, 5521, 5532, 5533, 5541, 5542, 5599, 7512, 7523, 7531, 7534, 7535, 7538, 7542, 7549],
  health: [4119, 5122, 5912, 5975, 5976, [8011, 8099]],
  beauty: [5977, 7230, 7297, 7298],
  clothes: [5137, 5139, 5611, 5621, 5631, 5651, 5655, 5661, 5681, 5691, 5697, 5698, 5699, 5931, 5948],
  home: [1520, 1711, 1731, 1740, 1750, 1761, 1771, 5039, 5200, 5211, 5231, 5251, 5261, 5331, 5712, 5713, 5714, 5718, 5719, 5722, 5950, 7210, 7211, 7216, 7217, 7342, 7349],
  utilities: [4814, 4816, 4821, 4900],
  digital: [4899, 5734, 5735, 5815, 5816, 5817, 5818, 7372],
  fun: [5940, 5941, 5942, 5970, 5994, 7832, 7841, 7911, 7922, 7929, 7932, 7933, 7941, 7991, 7992, 7993, 7994, 7996, 7997, 7998, 7999],
  kids: [5641, 5945, 8211, 8220, 8241, 8244, 8249, 8299, 8351],
  pets: [742, 5995],
  alcohol: [5921, 5993],
  tech: [4812, 5045, 5065, 5732, 5946],
  travel: [[3000, 3999], 4411, 4511, 4582, 4722, 4723, 7011, 7012, 7032, 7033],
  gov: [9211, 9222, 9223, 9311, 9399, 9402],
  finance: [5960, 6012, 6211, 6300, 6381],
  transfers: [4829, 6538, 6540],
  cash: [6010, 6011],
};

const BY_MCC = new Map<number, Category>();
const RANGES: [number, number, Category][] = [];
for (const [cat, list] of Object.entries(MCC) as [Category, (number | [number, number])[]][]) {
  for (const x of list) if (Array.isArray(x)) RANGES.push([x[0], x[1], cat]); else BY_MCC.set(x, cat);
}

export function mccCategory(mcc: number | null | undefined): Category {
  if (mcc == null) return 'other';
  return BY_MCC.get(mcc) ?? RANGES.find(([a, b]) => mcc >= a && mcc <= b)?.[2] ?? 'other';
}
