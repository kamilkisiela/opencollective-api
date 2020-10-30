import Promise from 'bluebird';
import config from 'config';
import { get } from 'lodash';
import moment from 'moment';

import models, { Op } from '../models';

import { TOKEN_EXPIRATION_LOGIN } from './auth';
import { fetchWithTimeout } from './fetch';
import logger from './logger';

export const getTransactionPdf = async (transaction, user) => {
  if (['ci', 'test'].includes(config.env)) {
    return;
  }
  const pdfUrl = `${config.host.pdf}/transactions/${transaction.uuid}/invoice.pdf`;
  const accessToken = user.jwt({}, TOKEN_EXPIRATION_LOGIN);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  return fetchWithTimeout(pdfUrl, { method: 'get', headers, timeoutInMs: 10000 })
    .then(response => {
      const { status } = response;
      if (status >= 200 && status < 300) {
        return response.body;
      } else {
        logger.warn('Failed to fetch PDF');
        return null;
      }
    })
    .catch(error => {
      logger.error(`Error fetching PDF: ${error.message}`);
    });
};

export const createConsolidatedInvoices = async fromCollective => {
  const transactions = await models.Transaction.findAll({
    attributes: ['createdAt', 'HostCollectiveId', 'amountInHostCurrency', 'hostCurrency'],
    where: {
      type: 'CREDIT',
      [Op.or]: [
        { FromCollectiveId: fromCollective.id, UsingVirtualCardFromCollectiveId: null },
        { UsingVirtualCardFromCollectiveId: fromCollective.id },
      ],
    },
  });

  const hostsById = {};
  const invoicesByKey = {};
  await Promise.map(transactions, async transaction => {
    const HostCollectiveId = transaction.HostCollectiveId;
    if (!HostCollectiveId) {
      return;
    }
    hostsById[HostCollectiveId] =
      hostsById[HostCollectiveId] ||
      (await models.Collective.findByPk(HostCollectiveId, {
        attributes: ['id', 'slug'],
      }));
    const createdAt = new Date(transaction.createdAt);
    const year = createdAt.getFullYear();
    const month = createdAt.getMonth() + 1;
    const month2digit = month < 10 ? `0${month}` : `${month}`;
    const slug = `${year}${month2digit}.${hostsById[HostCollectiveId].slug}.${fromCollective.slug}`;
    const totalAmount = invoicesByKey[slug]
      ? invoicesByKey[slug].totalAmount + transaction.amountInHostCurrency
      : transaction.amountInHostCurrency;
    const totalTransactions = invoicesByKey[slug] ? invoicesByKey[slug].totalTransactions + 1 : 1;

    invoicesByKey[slug] = {
      HostCollectiveId,
      FromCollectiveId: fromCollective.id,
      slug,
      year,
      month,
      totalAmount,
      totalTransactions,
      currency: transaction.hostCurrency,
    };
  });
  const invoices = [];
  Object.keys(invoicesByKey).forEach(key => invoices.push(invoicesByKey[key]));
  invoices.sort((a, b) => {
    return a.slug > b.slug ? -1 : 1;
  });
  return invoices;
};

export const getConsolidatedInvoicePdfs = async fromCollective => {
  if (['ci', 'test'].includes(config.env)) {
    return;
  }
  // https://{pdfUrl}/collectives/{fromCollective-User mopsa-mopsa}/{toCollective-Host brusselstogetherasbl}/{start of month 2020-09-01T00:00:00.000Z}/{end of month 2020-09-30T23:59:59.999Z}.pdf

  // Get invoices
  const invoices = await createConsolidatedInvoices(fromCollective);
  // an invoice
  // {
  //   HostCollectiveId: 9805,
  //   FromCollectiveId: 10884,
  //   slug: '202010.opensourceorg.mopsa-mopsa',
  //   year: 2020,
  //   month: 10,
  //   totalAmount: 57000,
  //   totalTransactions: 4,
  //   currency: 'USD'
  // },

  const pdfAttachments = [];

  // Get URL info from invoices
  for (const invoice of invoices) {
    const invoiceInfo = get(invoice, 'slug').split('.');
    const dateYYYYMM = invoiceInfo[0];
    const month = dateYYYYMM.slice(-2);
    const year = dateYYYYMM.slice(0, 4);
    const startDate = moment([year, month]);
    const endDate = moment(startDate).endOf('month');
    const startOfMonth = startDate.toISOString();
    const endOfMonth = endDate.toISOString();
    const toOrgCollectiveSlug = invoiceInfo[1];
    const fromCollectiveSlug = invoiceInfo[2];

    const fromCollectiveUser = await models.User.findOne({
      where: { CollectiveId: invoice.FromCollectiveId },
    });

    const pdfUrl = `${config.host.pdf}/collectives/${fromCollectiveSlug}/${toOrgCollectiveSlug}/${startOfMonth}/${endOfMonth}.pdf`;
    const accessToken = fromCollectiveUser.jwt({}, TOKEN_EXPIRATION_LOGIN);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
    };

    const invoicePdf = await fetchWithTimeout(pdfUrl, { method: 'get', headers, timeoutInMs: 10000 })
      .then(response => {
        const { status } = response;
        if (status >= 200 && status < 300) {
          return response.body;
        } else {
          logger.warn('Failed to fetch PDF');
          return null;
        }
      })
      .catch(error => {
        logger.error(`Error fetching PDF: ${error.message}`);
      });

    if (invoicePdf) {
      const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());
      pdfAttachments.push({
        filename: `transaction_${collective.slug}_${createdAtString}_${transaction.uuid}.pdf`,
        content: invoicePdf,
      });
    }
  }

  return pdfAttachments;
};
