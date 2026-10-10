export type TransactionType = 'expense' | 'income';

export type CategoryIconName =
  | 'utensils'
  | 'car'
  | 'shopping-bag'
  | 'file-text'
  | 'home'
  | 'tag'
  | 'circle-dollar-sign'
  | 'gift'
  | 'briefcase-business'
  | 'trending-up'
  | 'party-popper'
  | 'landmark';

export interface Category {
  id: string;
  name: string;
  icon: CategoryIconName;
  color: string;
  type: TransactionType;
  isDefault?: boolean;
}

export interface Transaction {
  id: string;
  amount: number;
  type: TransactionType;
  date: string;
  note: string;
  categoryId: string;
}

export interface BudgetState {
  overall: number | null;
  byCategory: Record<string, number>;
}

export interface Profile {
  nameThai: string;
  nameEnglish: string;
}

export interface AppData {
  transactions: Transaction[];
  categories: Category[];
  budgets: BudgetState;
  profile: Profile;
  settings: {
    darkMode: boolean;
  };
}

export interface Session {
  username: string;
  displayName: string;
  isDemo?: boolean;
}

export interface UserAccount {
  username: string;
  passwordHash: string;
  displayName: string;
}
