import { z } from 'zod';

/**
 * Two-level taxonomy. The model picks one subcategory (a leaf); the parent
 * category is derived in code, never asked for separately.
 *
 * This object is the only place the hierarchy is written down. Enums, gloss maps
 * and the leaf-to-parent mapping are all derived from it, so they cannot drift.
 *
 * No leaf may share an identifier with a parent. `search_transactions` exposes
 * `category` and `subcategory` as separate filters with different meanings, so a
 * shared identifier would let a caller pass one while meaning the other and no
 * schema would catch it. The rule holds even for single-leaf parents, where a
 * shared name would be harmless, because a conditional invariant is a weaker test.
 *
 * Every parent with more than one leaf carries a `<parent>_other` leaf, for the
 * case where the parent is established but the child is not. A more specific leaf
 * always wins over its `_other` sibling.
 */
const hierarchy = {
  food_drink: {
    label: 'Food and drink',
    subcategories: {
      groceries: 'Food and household staples from supermarkets and grocers.',
      dining: 'Restaurants, cafes, takeaway and food delivery.',
      food_drink_other: 'Food or drink where the kind of purchase cannot be established.',
    },
  },
  transport: {
    label: 'Transport',
    subcategories: {
      public_transport: 'Public transport, taxis, rideshare, parking and tolls.',
      fuel: 'Vehicle fuel and charging.',
      vehicle_maintenance: 'Vehicle servicing, repairs, tyres and registration.',
      transport_other: 'Transport where no more specific transport subcategory can be established.',
    },
  },
  housing: {
    label: 'Housing',
    subcategories: {
      rent: 'Rent paid to a landlord or agent.',
      mortgage: 'Home mortgage payments.',
      home_maintenance: 'Home repairs, tradespeople and upkeep.',
      utilities: 'Electricity, gas, water, internet and phone bills.',
      housing_other: 'Housing where no more specific housing subcategory can be established.',
    },
  },
  insurance: {
    label: 'Insurance',
    subcategories: { insurance_premiums: 'Insurance premiums of any kind.' },
  },
  health_wellbeing: {
    label: 'Health and wellbeing',
    subcategories: {
      health: 'Medical, dental, pharmacy and other health expenses.',
      fitness: 'Gyms, fitness classes and sports memberships.',
      personal_care: 'Grooming, hairdressing and beauty.',
      health_wellbeing_other:
        'Health or wellbeing where no more specific subcategory can be established.',
    },
  },
  lifestyle: {
    label: 'Lifestyle',
    subcategories: {
      entertainment: 'Cinema, events, games, streaming and leisure activities.',
      shopping: 'Retail purchases and consumer services outside more specific subcategories.',
      travel: 'Flights, accommodation and other travel expenses.',
      lifestyle_other: 'Lifestyle where no more specific lifestyle subcategory can be established.',
    },
  },
  education: {
    label: 'Education',
    subcategories: { tuition_courses: 'Tuition, courses and educational expenses.' },
  },
  giving: {
    label: 'Giving',
    subcategories: {
      gifts: 'Gifts to other people.',
      donations: 'Charitable donations.',
      giving_other: 'A gift or donation where which of the two applies cannot be established.',
    },
  },
  income: {
    label: 'Income',
    subcategories: {
      income_salary: 'Salary and wages received.',
      income_benefits: 'Pensions and government benefits received.',
      income_other: 'Other income received, including interest received.',
    },
  },
  financial_costs: {
    label: 'Financial costs',
    subcategories: {
      bank_fees: 'Account keeping, transaction and ATM fees.',
      interest_charged: 'Interest charged on credit cards and loans, never interest received.',
      tax: 'Tax payments and instalments, including ATO obligations.',
      loan_repayment:
        'Personal loan, car finance, buy-now-pay-later and credit card repayments, never a mortgage payment.',
      financial_costs_other:
        'A financial cost where no more specific subcategory can be established.',
    },
  },
  savings_investments: {
    label: 'Savings and investments',
    subcategories: {
      savings: 'Money moved into savings products.',
      investments: 'Brokerage funding, share purchases and voluntary superannuation contributions.',
      savings_investments_other:
        'Saving or investing where which of the two applies cannot be established.',
    },
  },
  cash: {
    label: 'Cash',
    subcategories: {
      cash_movement:
        'Physical cash only: ATM withdrawals and cash deposits. This records that cash moved; it does not reveal what the cash was ultimately spent on. An electronic credit or payment is never cash movement.',
    },
  },
  uncategorised: {
    label: 'Uncategorised',
    subcategories: {
      other:
        'Classification did not succeed: the description is unclear or fits no other subcategory.',
    },
  },
} as const;

export type ParentCategory = keyof typeof hierarchy;
export type Subcategory = {
  [P in ParentCategory]: keyof (typeof hierarchy)[P]['subcategories'];
}[ParentCategory];

export const parentCategories = Object.keys(hierarchy) as ParentCategory[];
export const parentCategorySchema = z.enum(parentCategories);

export const parentCategoryLabels = Object.fromEntries(
  parentCategories.map((parent) => [parent, hierarchy[parent].label]),
) as Record<ParentCategory, string>;

/** Leaves of one parent, in declaration order. */
export const subcategoriesOf = Object.fromEntries(
  parentCategories.map((parent) => [parent, Object.keys(hierarchy[parent].subcategories)]),
) as Record<ParentCategory, Subcategory[]>;

export const subcategories = parentCategories.flatMap((parent) => subcategoriesOf[parent]);
export const subcategorySchema = z.enum(subcategories);

/** Total: every valid subcategory has exactly one parent. */
export const parentOf = Object.fromEntries(
  parentCategories.flatMap((parent) =>
    subcategoriesOf[parent].map((subcategory) => [subcategory, parent]),
  ),
) as Record<Subcategory, ParentCategory>;

export const subcategoryGlosses = Object.fromEntries(
  parentCategories.flatMap((parent) =>
    Object.entries(hierarchy[parent].subcategories as Record<string, string>),
  ),
) as Record<Subcategory, string>;

/**
 * The parent a stored label rolls up to. An unlabelled row and an unknown label
 * both read as `uncategorised`, which is what an unlabelled row means.
 */
export function categoryOf(subcategory: string | null | undefined): ParentCategory {
  if (subcategory === null || subcategory === undefined) return 'uncategorised';
  return parentOf[subcategory as Subcategory] ?? 'uncategorised';
}

/**
 * Boundaries the glosses alone leave ambiguous. Sent to the classifier with the
 * taxonomy; kept here so the rules and the taxonomy stay together.
 */
export const classificationRules = [
  'Choose the most specific subcategory the description supports. Use a parent _other subcategory only when the parent is clear but the child is not, and other only when even the parent is unknown.',
  'Government tax obligations are tax; bank charges are bank_fees; accounting and advisory fees are shopping, not tax.',
  'Mortgage payments are mortgage, never loan_repayment. Do not infer a principal and interest split from a description.',
  'Pharmacies are health, gyms are fitness, and shopping is the fallback for ordinary retail.',
  'Classify by purpose, not by cadence: streaming is entertainment and a gym membership is fitness.',
  'Insurance is independent: an insurance premium is insurance_premiums whatever it insures.',
  'Do not infer gifts from ordinary retail purchases, or travel from ordinary restaurant payments.',
  'Physical cash withdrawals and deposits are cash_movement, which records the movement and not the eventual purpose. An electronic credit from a company or platform is income, never cash_movement.',
  'savings and investments describe purpose only and never imply a transfer; transfer_hint never implies either.',
  'transfer_hint is true only when the description suggests money moving between two accounts the same person owns, such as a named move to their own savings account or credit card. Money from or to a named third party (an employer, a platform, a company, another person) is not an own-account movement, even when the description contains the word transfer. When in doubt, answer false.',
] as const;
