// Spending categories and the built-in rules used to categorise Australian transactions automatically.

export const CATEGORIES = [
  'Income', 'Groceries', 'Eating out', 'Transport', 'Fuel', 'Rent & Mortgage', 'Bills & Utilities',
  'Phone & Internet', 'Insurance', 'Health', 'Shopping', 'Entertainment', 'Subscriptions', 'Travel',
  'Education', 'Personal care', 'Gifts & Donations', 'Fees & Interest', 'Debt repayments',
  'Savings & Transfers', 'Business', 'Other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Fixed commitments. Excluded from "spent this week" because they're already set aside as commitments. */
export const COMMITTED_CATEGORIES: Category[] = [
  'Rent & Mortgage', 'Bills & Utilities', 'Phone & Internet', 'Insurance', 'Subscriptions', 'Debt repayments', 'Savings & Transfers',
];

/** Categories where cutting back is usually possible. Used for "unnecessary spending" insights. */
export const DISCRETIONARY_CATEGORIES: Category[] = ['Eating out', 'Shopping', 'Entertainment', 'Subscriptions', 'Travel', 'Personal care', 'Gifts & Donations'];

const BUILT_IN: [RegExp, Category][] = [
  [/\b(salary|payroll|wages?|pay ?run|centrelink|ato refund|tax refund|dividend)\b/i, 'Income'],
  [/\b(transfer to|transfer from|tfr|internal transfer|to savings|bpay transfer|osko to|savings acc)/i, 'Savings & Transfers'],
  [/\b(uber\s*\*?\s*eats|menulog|doordash|deliveroo|mcdonald|maccas|kfc|hungry jack|domino|subway|grill'?d|guzman|cafe|coffee|restaurant|sushi|pizza|bakery|starbucks|nando)/i, 'Eating out'],
  [/\b(woolworths|woolies|coles|aldi|iga|harris farm|foodworks|costco|drakes|spudshed)\b/i, 'Groceries'],
  [/\b(netflix|spotify|stan\.com|stan |disney|binge|kayo|paramount|youtube premium|apple\.com\/bill|icloud|amazon prime|audible|chatgpt|openai|anthropic|claude\.ai|adobe|microsoft 365|xbox game pass|playstation plus)/i, 'Subscriptions'],
  [/\b(bp |bp$|shell|caltex|ampol|7-eleven|7 eleven|united petrol|puma energy|metro petroleum|liberty oil)/i, 'Fuel'],
  [/\b(myki|opal|translink|go card|ptv|uber|didi|ola |13cabs|taxi|linkt|citylink|eastlink|toll|parking|wilson parking|secure parking)/i, 'Transport'],
  [/\b(agl|origin energy|energyaustralia|red energy|alinta|simply energy|lumo|momentum energy|powershop|yarra valley water|south east water|sydney water|council rates|gas bill|electricity)/i, 'Bills & Utilities'],
  [/\b(telstra|optus|vodafone|tpg|aussie broadband|iinet|belong|amaysim|boost mobile|superloop|exetel|nbn)/i, 'Phone & Internet'],
  [/\b(medibank|bupa|nib|hcf|ahm|aami|allianz|budget direct|racv|nrma|youi|qbe|suncorp|insurance)/i, 'Insurance'],
  [/\b(chemist warehouse|priceline|pharmacy|medical|doctor|dental|dentist|physio|pathology|hospital|optometrist|specsavers)/i, 'Health'],
  [/\b(kmart|target|big w|jb hi-?fi|harvey norman|myer|david jones|bunnings|officeworks|ikea|amazon|ebay|the iconic|uniqlo|rebel sport|catch\.com)/i, 'Shopping'],
  [/\b(hoyts|village cinemas|event cinemas|ticketek|ticketmaster|steam|playstation|nintendo|xbox|bowling|timezone)/i, 'Entertainment'],
  [/\b(qantas|virgin australia|jetstar|rex airlines|airbnb|booking\.com|expedia|hotel|motel)/i, 'Travel'],
  [/\b(rent|real estate|realestate|mortgage|home loan|strata|body corporate)/i, 'Rent & Mortgage'],
  [/\b(hairdress|barber|salon|beauty|nail|gym|fitness|anytime fitness|f45)/i, 'Personal care'],
  [/\b(university|tafe|udemy|coursera|school fees|textbook)/i, 'Education'],
  [/\b(donation|charity|red cross|unicef|gofundme)/i, 'Gifts & Donations'],
  [/\b(fee|interest charged|overdrawn|dishonour|late payment|annual fee|international transaction)/i, 'Fees & Interest'],
  [/\b(afterpay|zip pay|zip money|humm|credit card payment|loan repayment|personal loan)/i, 'Debt repayments'],
];

export interface UserRule { pattern: string; category: string }

/** Picks a category: your own rules first, then the built-in rules, then Income/Other by sign. */
export function categorise(description: string, amountCents: number, userRules: UserRule[] = []): Category {
  const d = description.toLowerCase();
  for (const r of userRules) if (d.includes(r.pattern.toLowerCase()) && isCategory(r.category)) return r.category;
  for (const [re, cat] of BUILT_IN) {
    if (!re.test(description)) continue;
    // Money coming in is only "Income" or a transfer; money going out is never "Income".
    if (amountCents > 0 && cat !== 'Income' && cat !== 'Savings & Transfers') continue;
    if (amountCents < 0 && cat === 'Income') continue;
    return cat;
  }
  return amountCents > 0 ? 'Income' : 'Other';
}

export function isCategory(c: string): c is Category {
  return (CATEGORIES as readonly string[]).includes(c);
}

export function kindFor(amountCents: number, category: string): 'income' | 'expense' | 'transfer' {
  if (category === 'Savings & Transfers') return 'transfer';
  return amountCents > 0 ? 'income' : 'expense';
}
