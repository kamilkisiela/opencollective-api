/** @module constants/transactions */

/** Percentage that Open Collective charges per transaction: 5% */
export const OC_FEE_PERCENT = 5;

/** Default per transaction host fee percentage */
export const HOST_FEE_PERCENT = 5;

/** Types of Transactions */
export const TransactionTypes = {
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
};

export const FEES_ON_TOP_TRANSACTION_PROPERTIES = {
  CollectiveId: 8686, // Open Collective (Organization)
  HostCollectiveId: 8686, // Open Collective (Organization)
  hostCurrency: 'USD',
  currency: 'USD',
};
