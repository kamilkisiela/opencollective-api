import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
} from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { Kind } from 'graphql/language';
import { get, omit, pick } from 'lodash';
import moment from 'moment';

import status from '../../constants/expense_status';
import intervals from '../../constants/intervals';
import { maxInteger } from '../../constants/math';
import orderStatus from '../../constants/order_status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPES } from '../../constants/paymentMethods';
import roles from '../../constants/roles';
import { getCollectiveAvatarUrl } from '../../lib/collectivelib';
import { getContributorsForTier } from '../../lib/contributors';
import { stripTags } from '../../lib/utils';
import models, { Op, sequelize } from '../../models';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import * as commonComment from '../common/comment';
import { allowContextPermission, PERMISSION_TYPE } from '../common/context-permissions';
import { canComment, canSeeExpenseAttachments, canSeeExpensePayoutMethod, getExpenseItems } from '../common/expenses';
import { idEncode, IDENTIFIER_TYPES } from '../v2/identifiers';

import { CollectiveInterfaceType, CollectiveSearchResultsType } from './CollectiveInterface';
import { TransactionInterfaceType } from './TransactionInterface';

/**
 * Take a graphql type and return a wrapper type that adds pagination. The pagination
 * object has limit, offset and total keys to manage pages and stores the result
 * of the query under the `values` key.
 *
 * @param {object} GraphQL type to paginate
 * @param {string} The name of the type, used to generate name and description.
 */
export const paginatedList = (type, typeName, valuesKey = 'nodes') => {
  return new GraphQLObjectType({
    name: `Paginated${typeName}`,
    description: `A list of ${typeName} with pagination info`,
    fields: {
      [valuesKey]: { type: new GraphQLList(type) },
      total: { type: GraphQLInt },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
  });
};

export const DateString = new GraphQLScalarType({
  name: 'DateString',
  serialize: value => {
    return value.toString();
  },
});

export const IsoDateString = new GraphQLScalarType({
  name: 'IsoDateString',
  serialize: value => {
    return value;
  },
  parseValue: value => {
    return value;
  },
  parseLiteral: ast => {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(`Query error: Can only parse strings got a: ${ast.kind}`);
    }

    const date = moment.parseZone(ast.value);
    if (!date.isValid()) {
      throw new GraphQLError('Query error: unable to pass date string. Expected a valid ISO-8601 date string.');
    }
    return date;
  },
});

export const PayoutMethodTypeEnum = new GraphQLEnumType({
  name: 'PayoutMethodTypeEnum',
  values: Object.keys(PayoutMethodTypes).reduce((values, key) => {
    return { ...values, [key]: { value: PayoutMethodTypes[key] } };
  }, {}),
});

export const UpdateAudienceTypeEnum = new GraphQLEnumType({
  name: 'UpdateAudienceTypeEnum',
  description: 'Defines targets for an update',
  values: {
    ALL: {
      description: 'Will be sent to collective admins and financial contributors',
    },
    COLLECTIVE_ADMINS: {
      description: 'Will be sent to collective admins',
    },
    FINANCIAL_CONTRIBUTORS: {
      description: 'Will be sent to financial contributors',
    },
  },
});

export const PayoutMethodType = new GraphQLObjectType({
  name: 'PayoutMethod',
  description: 'A payout method for expenses',
  fields: {
    id: {
      type: GraphQLInt,
    },
    type: {
      type: PayoutMethodTypeEnum,
    },
    name: {
      type: GraphQLString,
    },
    isSaved: {
      type: GraphQLBoolean,
    },
    data: {
      type: GraphQLJSON,
    },
  },
});

export const UserType = new GraphQLObjectType({
  name: 'UserDetails',
  description: 'This represents the details of a User',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(user) {
          return user.id;
        },
      },
      CollectiveId: {
        type: GraphQLInt,
        resolve(user) {
          return user.CollectiveId;
        },
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve(user, args, req) {
          if (!user.CollectiveId) {
            return console.error('>>> user', user.id, 'does not have a CollectiveId', user.CollectiveId);
          }
          return req.loaders.Collective.byId.load(user.CollectiveId);
        },
      },
      username: {
        type: GraphQLString,
        resolve(user) {
          return user.username;
        },
      },
      firstName: {
        type: GraphQLString,
        resolve(user) {
          return user.firstName;
        },
      },
      lastName: {
        type: GraphQLString,
        resolve(user) {
          return user.lastName;
        },
      },
      name: {
        type: GraphQLString,
        resolve(user) {
          return user.name;
        },
      },
      image: {
        type: GraphQLString,
        resolve(user) {
          return user.image;
        },
      },
      email: {
        type: GraphQLString,
        resolve(user, args, req) {
          return user.getPersonalDetails && user.getPersonalDetails(req.remoteUser).then(user => user.email);
        },
      },
      emailWaitingForValidation: {
        type: GraphQLString,
        resolve(user, args, req) {
          return (
            user.getPersonalDetails &&
            user.getPersonalDetails(req.remoteUser).then(user => user.emailWaitingForValidation)
          );
        },
      },
      memberOf: {
        type: new GraphQLList(MemberType),
        args: {
          roles: { type: new GraphQLList(GraphQLString) },
          includeIncognito: {
            type: GraphQLBoolean,
            defaultValue: true,
            description:
              'Wether incognito profiles should be included in the result. Only works if requesting user is an admin of the account.',
          },
        },
        resolve(user, args, req) {
          const where = { MemberCollectiveId: user.CollectiveId };
          if (args.roles && args.roles.length > 0) {
            where.role = { [Op.in]: args.roles };
          }

          const collectiveConditions = {};
          if (!args.includeIncognito || !req.remoteUser?.isAdmin(user.CollectiveId)) {
            collectiveConditions.isIncognito = false;
          }

          return models.Member.findAll({
            where,
            include: [
              {
                model: models.Collective,
                as: 'collective',
                required: true,
                where: collectiveConditions,
              },
            ],
          });
        },
      },
      paypalEmail: {
        type: GraphQLString,
        deprecationReason: '2020-01-20 - Payout methods are now attached to collectives',
        async resolve(user, args, req) {
          if (!req.remoteUser || !(await req.loaders.User.canSeeUserPrivateInfo.load(user))) {
            return null;
          } else {
            const payoutMethods = await req.loaders.PayoutMethod.paypalByCollectiveId.load(user.CollectiveId);
            return get(payoutMethods[0], 'data.email');
          }
        },
      },
      isLimited: {
        type: GraphQLBoolean,
        description: "Returns true if user account is limited (user can't use any feature)",
        resolve(user) {
          return user.data && user.data.features && user.data.features.ALL === false;
        },
      },
    };
  },
});

export const StatsMemberType = new GraphQLObjectType({
  name: 'StatsMemberType',
  description: 'Stats about a membership',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching (key: __typename+id)
      id: {
        type: GraphQLInt,
        resolve(member) {
          return member.id;
        },
      },
      directDonations: {
        type: GraphQLInt,
        description: 'total amount donated directly by this member',
        resolve(member, args, req) {
          return (
            member.directDonations ||
            req.loaders.Transaction.directDonationsFromTo.load({
              FromCollectiveId: member.MemberCollectiveId,
              CollectiveId: member.CollectiveId,
            })
          );
        },
      },
      donationsThroughEmittedVirtualCards: {
        type: GraphQLInt,
        description: 'total amount donated by this member through gift cards',
        resolve(member, args, req) {
          return (
            member.donationsThroughEmittedVirtualCards ||
            req.loaders.Transaction.donationsThroughEmittedVirtualCardsFromTo.load({
              FromCollectiveId: member.MemberCollectiveId,
              CollectiveId: member.CollectiveId,
            })
          );
        },
      },
      totalDonations: {
        type: GraphQLInt,
        description: 'total amount donated by this member either directly or using a virtual card it has emitted',
        resolve(member, args, req) {
          return (
            member.totalDonations ||
            req.loaders.Transaction.totalAmountDonatedFromTo.load({
              FromCollectiveId: member.MemberCollectiveId,
              CollectiveId: member.CollectiveId,
            })
          );
        },
      },
    };
  },
});

export const MemberType = new GraphQLObjectType({
  name: 'Member',
  description: 'This is a Member',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(member) {
          return member.id;
        },
      },
      createdAt: {
        type: DateString,
        resolve(member) {
          return member.createdAt;
        },
      },
      orders: {
        type: new GraphQLList(OrderType),
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        resolve(member, args, req) {
          return req.loaders.Order.findByMembership
            .load(`${member.CollectiveId}:${member.MemberCollectiveId}`)
            .then(orders => {
              const { limit, offset } = args;
              if (limit) {
                return orders.splice(offset || 0, limit);
              } else {
                return orders;
              }
            });
        },
      },
      transactions: {
        type: new GraphQLList(TransactionInterfaceType),
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        resolve(member, args, req) {
          return req.loaders.Member.transactions
            .load(`${member.CollectiveId}:${member.MemberCollectiveId}`)
            .then(transactions => {
              /**
               * xdamman: note: we can't pass a limit to the loader
               * because the limit would be applied to the entire result set
               * that includes the transactions from other members
               * Given that the number of transaction for a given member to a given collective
               * is expected to always be < 100, the tradeoff is in favor of using the DataLoader
               */
              const { limit, offset } = args;
              if (limit) {
                return transactions.splice(offset || 0, limit);
              } else {
                return transactions;
              }
            });
        },
      },
      collective: {
        type: CollectiveInterfaceType,
        async resolve(member, args, req) {
          const collective = member.collective || (await req.loaders.Collective.byId.load(member.CollectiveId));
          if (!collective?.isIncognito || req.remoteUser?.isAdmin(collective.id)) {
            return collective;
          }
        },
      },
      member: {
        type: CollectiveInterfaceType,
        async resolve(member, args, req) {
          const memberCollective =
            member.memberCollective || (await req.loaders.Collective.byId.load(member.MemberCollectiveId));
          const collective = member.collective || (await req.loaders.Collective.byId.load(member.CollectiveId));

          if (memberCollective && req.remoteUser && req.remoteUser.isAdmin(member.CollectiveId)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_INCOGNITO_ACCOUNT_DETAILS, memberCollective.id);
          } else if (collective?.isIncognito) {
            return null;
          }

          return memberCollective;
        },
      },
      role: {
        type: GraphQLString,
        resolve(member) {
          return member.role;
        },
      },
      description: {
        type: GraphQLString,
        resolve(member) {
          return member.description;
        },
      },
      publicMessage: {
        description: 'Custom user message from member to the collective',
        type: GraphQLString,
        resolve(member) {
          return member.publicMessage;
        },
      },
      tier: {
        type: TierType,
        resolve(member, args, req) {
          return member.TierId && req.loaders.Tier.byId.load(member.TierId);
        },
      },
      stats: {
        type: StatsMemberType,
        resolve(member) {
          return member;
        },
      },
      since: {
        type: DateString,
        resolve(member) {
          return member.since;
        },
      },
    };
  },
});

export const MemberInvitationType = new GraphQLObjectType({
  name: 'MemberInvitation',
  description: 'An invitation to join the members of a collective',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
      },
      createdAt: {
        type: DateString,
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve(member, args, req) {
          return req.loaders.Collective.byId.load(member.CollectiveId);
        },
      },
      member: {
        type: CollectiveInterfaceType,
        resolve(member, args, req) {
          return req.loaders.Collective.byId.load(member.MemberCollectiveId);
        },
      },
      role: {
        type: GraphQLString,
      },
      description: {
        type: GraphQLString,
      },
      tier: {
        type: TierType,
        resolve(member, args, req) {
          return member.TierId && req.loaders.Tier.byId.load(member.TierId);
        },
      },
      since: {
        type: DateString,
        resolve(member) {
          return member.since;
        },
      },
    };
  },
});

export const ContributorRoleEnum = new GraphQLEnumType({
  name: 'ContributorRole',
  description: 'Possible roles for a contributor. Extends `Member.Role`.',
  values: Object.values(roles).reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});

export const ImageFormatType = new GraphQLEnumType({
  name: 'ImageFormat',
  values: {
    txt: {},
    png: {},
    jpg: {},
    gif: {},
    svg: {},
  },
});

export const ContributorType = new GraphQLObjectType({
  name: 'Contributor',
  description: `
    A person or an entity that contributes financially or by any other mean to the mission
    of the collective. While "Member" is dedicated to permissions, this type is meant
    to surface all the public contributors.
  `,
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'A unique identifier for this member',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Name of the contributor',
    },
    roles: {
      type: new GraphQLList(ContributorRoleEnum),
      description: 'All the roles for a given contributor',
      defaultValue: [roles.CONTRIBUTOR],
    },
    isAdmin: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if the contributor is a collective admin',
    },
    isCore: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if the contributor is a core contributor',
    },
    isBacker: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if the contributor is a financial contributor',
    },
    isFundraiser: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if the contributor is a fundraiser',
    },
    tiersIds: {
      type: new GraphQLNonNull(new GraphQLList(GraphQLInt)),
      description:
        'A list of tier ids that this contributors is a member of. A null value indicates that a membership without tier.',
    },
    since: {
      type: new GraphQLNonNull(IsoDateString),
      description: 'Member join date',
    },
    totalAmountDonated: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'How much money the user has contributed for this (in cents, using collective currency)',
    },
    type: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Wether the contributor is an individual, an organization...',
    },
    isIncognito: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Defines if the contributors wants to be incognito (name not displayed)',
    },
    isGuest: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Defines if the contributors is a guest account',
    },
    description: {
      type: GraphQLString,
      description: 'Description of how the member contribute. Will usually be a tier name, or "design" or "code".',
    },
    collectiveSlug: {
      type: GraphQLString,
      description: 'If the contributor has a page on Open Collective, this is the slug to link to it',
      resolve(contributor) {
        // Don't return the collective slug if the contributor wants to be incognito
        return contributor.isIncognito ? null : contributor.collectiveSlug;
      },
    },
    collectiveId: {
      type: GraphQLInt,
      description: 'Null for incognito collectives otherwise collective id',
      resolve(contributor) {
        // Don't return the collective id if the contributor wants to be incognito
        return contributor.isIncognito ? null : contributor.id;
      },
    },
    image: {
      type: GraphQLString,
      description: 'Contributor avatar or logo',
      args: {
        height: { type: GraphQLInt },
        format: { type: ImageFormatType },
      },
      resolve(contributor, args) {
        if (!contributor.collectiveSlug) {
          return null;
        } else {
          return getCollectiveAvatarUrl(contributor.collectiveSlug, contributor.type, contributor.image, args);
        }
      },
    },
    publicMessage: {
      type: GraphQLString,
      description: 'A public message from contributors to describe their contributions',
    },
  },
});

export const LocationType = new GraphQLObjectType({
  name: 'LocationType',
  description: 'Type for Location',
  fields: () => ({
    name: {
      type: GraphQLString,
      description: 'A short name for the location (eg. Google Headquarters)',
    },
    address: {
      type: GraphQLString,
      description: 'Postal address without country (eg. 12 opensource avenue, 7500 Paris)',
    },
    country: {
      type: GraphQLString,
      description: 'Two letters country code (eg. FR, BE...etc)',
    },
    lat: {
      type: GraphQLFloat,
      description: 'Latitude',
    },
    long: {
      type: GraphQLFloat,
      description: 'Longitude',
    },
  }),
});

export const InvoiceType = new GraphQLObjectType({
  name: 'InvoiceType',
  description: 'This represents an Invoice',
  fields: () => {
    return {
      slug: {
        type: GraphQLString,
        resolve(invoice) {
          return invoice.slug;
        },
      },
      title: {
        type: GraphQLString,
        description:
          'Title for the invoice. Depending on the type of legal entity, a host should issue an Invoice or a Receipt.',
        resolve(invoice) {
          return invoice.title;
        },
      },
      extraInfo: {
        type: GraphQLString,
        description:
          'more info about the invoice, which is then printed on receipts that go to financial contributors.',
        resolve(invoice) {
          return invoice.extraInfo;
        },
      },
      dateFrom: {
        type: IsoDateString,
        description:
          'dateFrom and dateTo will be set for any invoice over a period of time. They will not be set for an invoice for a single transaction.',
        resolve: invoice => invoice.dateFrom,
      },
      dateTo: {
        type: IsoDateString,
        description:
          'dateFrom and dateTo will be set for any invoice over a period of time. They will not be set for an invoice for a single transaction.',
        resolve: invoice => invoice.dateTo,
      },
      year: {
        type: GraphQLInt,
        description: 'year will be set for an invoice for a single transaction. Otherwise, prefer dateFrom, dateTo',
        resolve(invoice) {
          return invoice.year;
        },
      },
      month: {
        type: GraphQLInt,
        description: 'month will be set for an invoice for a single transaction. Otherwise, prefer dateFrom, dateTo',
        resolve(invoice) {
          return invoice.month;
        },
      },
      day: {
        type: GraphQLInt,
        description: 'day will be set for an invoice for a single transaction. Otherwise, prefer dateFrom, dateTo',
        resolve(invoice) {
          return invoice.day;
        },
      },
      totalAmount: {
        type: GraphQLInt,
        resolve(invoice) {
          return invoice.totalAmount;
        },
      },
      totalTransactions: {
        type: GraphQLInt,
        resolve(invoice) {
          return invoice.totalTransactions;
        },
      },
      currency: {
        type: GraphQLString,
        resolve(invoice) {
          return invoice.currency;
        },
      },
      host: {
        type: CollectiveInterfaceType,
        resolve(invoice, args, req) {
          return req.loaders.Collective.byId.load(invoice.HostCollectiveId);
        },
      },
      fromCollective: {
        type: CollectiveInterfaceType,
        async resolve(invoice, args, req) {
          const fromCollective = await req.loaders.Collective.byId.load(invoice.FromCollectiveId);
          if (fromCollective && req.remoteUser.isAdmin(fromCollective.id)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_INCOGNITO_ACCOUNT_DETAILS, fromCollective.id);
          }
          return fromCollective;
        },
      },
      transactions: {
        type: new GraphQLList(TransactionInterfaceType),
        async resolve(invoice) {
          // Directly return transactions if already loaded
          if (invoice.transactions) {
            return invoice.transactions;
          }

          const where = {
            [Op.or]: {
              FromCollectiveId: invoice.FromCollectiveId,
              UsingVirtualCardFromCollectiveId: invoice.FromCollectiveId,
            },
            type: 'CREDIT',
            createdAt: { [Op.gte]: invoice.dateFrom, [Op.lt]: invoice.dateTo },
          };
          if (invoice.HostCollectiveId) {
            where.HostCollectiveId = invoice.HostCollectiveId;
          }
          const transactions = await models.Transaction.findAll({ where });
          return transactions;
        },
      },
    };
  },
});

export const ExpenseItemType = new GraphQLObjectType({
  name: 'ExpenseItem',
  description: 'Public fields for an expense item',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLInt) },
    amount: { type: new GraphQLNonNull(GraphQLInt) },
    createdAt: { type: new GraphQLNonNull(IsoDateString) },
    updatedAt: { type: new GraphQLNonNull(IsoDateString) },
    incurredAt: { type: new GraphQLNonNull(IsoDateString) },
    deletedAt: { type: IsoDateString },
    description: { type: GraphQLString },
    url: { type: GraphQLString },
  },
});

const ExpenseAttachedFile = new GraphQLObjectType({
  name: 'ExpenseAttachedFile',
  description: "Fields for an expense's attached file",
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Unique identifier for this file',
    },
    url: {
      type: GraphQLString,
    },
  },
});

export const ExpenseType = new GraphQLObjectType({
  name: 'ExpenseType',
  description: 'This represents an Expense',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(expense) {
          return expense.id;
        },
      },
      idV2: {
        type: GraphQLString,
        resolve(expense) {
          return idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE);
        },
      },
      amount: {
        type: GraphQLInt,
        resolve(expense) {
          return expense.amount;
        },
      },
      currency: {
        type: GraphQLString,
        resolve(expense) {
          return expense.currency;
        },
      },
      createdAt: {
        type: DateString,
        resolve(expense) {
          return expense.createdAt;
        },
      },
      updatedAt: {
        type: DateString,
        resolve(expense) {
          return expense.updatedAt;
        },
      },
      incurredAt: {
        type: DateString,
        resolve(expense) {
          return expense.incurredAt;
        },
      },
      description: {
        type: GraphQLString,
        resolve(expense) {
          return expense.description;
        },
      },
      category: {
        type: GraphQLString,
        deprecationReason: '2020-04-01 - Please use tags',
        resolve(expense) {
          return expense.tags?.[0] || null;
        },
      },
      tags: {
        type: new GraphQLList(GraphQLString),
        resolve(expense) {
          return expense.tags;
        },
      },
      status: {
        type: GraphQLString,
        resolve(expense) {
          return expense.status;
        },
      },
      type: {
        type: GraphQLString,
        resolve(expense) {
          return expense.type;
        },
      },
      payoutMethod: {
        type: GraphQLString,
        deprecationReason: '2020-01-23 - Please use the private field instead.',
        resolve(expense) {
          return expense.legacyPayoutMethod;
        },
      },
      PayoutMethod: {
        type: PayoutMethodType,
        async resolve(expense, _, req) {
          if (!expense.PayoutMethodId || !(await canSeeExpensePayoutMethod(req, expense))) {
            return null;
          } else {
            return expense.payoutMethod || req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId);
          }
        },
      },
      privateMessage: {
        type: GraphQLString,
        resolve(expense, args, req) {
          if (!req.remoteUser) {
            return null;
          }
          if (req.remoteUser.isAdmin(expense.CollectiveId) || req.remoteUser.id === expense.UserId) {
            return expense.privateMessage;
          }
          return req.loaders.Collective.byId.load(expense.CollectiveId).then(collective => {
            if (req.remoteUser.isAdmin(collective.HostCollectiveId)) {
              return expense.privateMessage;
            } else {
              return null;
            }
          });
        },
      },
      attachment: {
        type: GraphQLString,
        deprecationReason: '2020-01-13 - Expenses now support multiple attachments. Please use attachments instead.',
        async resolve(expense, args, req) {
          if (!(await canSeeExpenseAttachments(req, expense))) {
            return null;
          } else {
            const attachments = await getExpenseItems(expense.id, req);
            return attachments[0] && attachments[0].url;
          }
        },
      },
      attachments: {
        type: new GraphQLList(ExpenseItemType),
        deprecationReason: '2020-04-09 - Please use items',
        async resolve(expense, _, req) {
          const canSeeAttachments = await canSeeExpenseAttachments(req, expense);
          return (await getExpenseItems(expense.id, req)).map(async item => {
            if (canSeeAttachments) {
              return item;
            } else {
              return omit(item, ['url']);
            }
          });
        },
      },
      items: {
        type: new GraphQLList(ExpenseItemType),
        async resolve(expense, _, req) {
          const canSeeAttachments = await canSeeExpenseAttachments(req, expense);
          return (await getExpenseItems(expense.id, req)).map(async item => {
            if (canSeeAttachments) {
              return item;
            } else {
              return omit(item, ['url']);
            }
          });
        },
      },
      attachedFiles: {
        type: new GraphQLList(new GraphQLNonNull(ExpenseAttachedFile)),
        async resolve(expense, _, req) {
          if (await canSeeExpenseAttachments(req, expense)) {
            return req.loaders.Expense.attachedFiles.load(expense.id);
          }
        },
      },
      userTaxFormRequiredBeforePayment: {
        type: GraphQLBoolean,
        async resolve(expense, _, req) {
          return req.loaders.Expense.userTaxFormRequiredBeforePayment.load(expense.id);
        },
      },
      user: {
        type: UserType,
        async resolve(expense, _, req) {
          return req.loaders.User.byId.load(expense.UserId);
        },
      },
      fromCollective: {
        type: CollectiveInterfaceType,
        resolve(expense, _, req) {
          return req.loaders.Collective.byId.load(expense.FromCollectiveId);
        },
      },
      comments: {
        type: CommentListType,
        description: 'Returns the list of comments for this expense, or `null` if user is not allowed to see them',
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        async resolve(expense, args, req) {
          if (!(await canComment(req, expense))) {
            return null;
          }

          return {
            where: { ExpenseId: expense.id },
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve(expense, args, req) {
          return req.loaders.Collective.byId.load(expense.CollectiveId);
        },
      },
      transaction: {
        type: TransactionInterfaceType,
        description: 'Returns the DEBIT transaction to pay out this expense',
        resolve(expense) {
          return models.Transaction.findOne({
            where: {
              type: 'DEBIT',
              CollectiveId: expense.CollectiveId,
              ExpenseId: expense.id,
            },
          });
        },
      },
    };
  },
});

export const UpdateType = new GraphQLObjectType({
  name: 'UpdateType',
  description: 'This represents an Update',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(expense) {
          return expense.id;
        },
      },
      views: {
        type: GraphQLInt,
        resolve(update) {
          return update.views;
        },
      },
      slug: {
        type: GraphQLString,
        resolve(update) {
          return update.slug;
        },
      },
      image: {
        type: GraphQLString,
        resolve(update) {
          return update.image;
        },
      },
      isPrivate: {
        type: GraphQLBoolean,
        resolve(update) {
          return update.isPrivate;
        },
      },
      notificationAudience: {
        type: UpdateAudienceTypeEnum,
        resolve(update) {
          return update.notificationAudience;
        },
      },
      makePublicOn: {
        type: IsoDateString,
        resolve(update) {
          return update.makePublicOn;
        },
      },
      userCanSeeUpdate: {
        description: 'Indicates whether or not the user is allowed to see the content of this update',
        type: GraphQLBoolean,
        resolve(update, _, req) {
          if (!update.isPrivate) {
            return true;
          }
          return req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId);
        },
      },
      title: {
        type: GraphQLString,
        resolve(update) {
          return update.title;
        },
      },
      createdAt: {
        type: DateString,
        resolve(update) {
          return update.createdAt;
        },
      },
      updatedAt: {
        type: DateString,
        resolve(update) {
          return update.updatedAt;
        },
      },
      publishedAt: {
        type: DateString,
        resolve(update) {
          return update.publishedAt;
        },
      },
      summary: {
        type: GraphQLString,
        resolve(update, _, req) {
          if (update.isPrivate && !(req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId))) {
            return null;
          }

          return update.summary || '';
        },
      },
      html: {
        type: GraphQLString,
        resolve(update, _, req) {
          if (update.isPrivate && !(req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId))) {
            return null;
          }

          return stripTags(update.html || '');
        },
      },
      markdown: {
        type: GraphQLString,
        resolve(update, _, req) {
          if (update.isPrivate && !(req.remoteUser && req.remoteUser.canSeeUpdates(update.CollectiveId))) {
            return null;
          }

          return stripTags(update.markdown || '');
        },
      },
      tags: {
        type: new GraphQLList(GraphQLString),
        resolve(update) {
          return update.tags;
        },
      },
      createdByUser: {
        type: UserType,
        resolve(update) {
          return update.getUser();
        },
      },
      fromCollective: {
        type: CollectiveInterfaceType,
        resolve(update, args, req) {
          return req.loaders.Collective.byId.load(update.FromCollectiveId);
        },
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve(update, args, req) {
          return req.loaders.Collective.byId.load(update.CollectiveId);
        },
      },
      tier: {
        type: TierType,
        resolve(update, args, req) {
          return req.loaders.Tier.byId.load(update.TierId);
        },
      },
      comments: {
        type: CommentListType,
        deprecationReason: 'Deprecated since 2020-03-18: This field has never been active and will be removed soon.',
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        resolve(update, args) {
          return {
            where: { UpdateId: update.id },
            limit: args.limit || 10,
            offset: args.offset || 0,
          };
        },
      },
    };
  },
});

export const CommentListType = new GraphQLObjectType({
  name: 'CommentListType',
  deprecationReason: 'The resolver for comments is not standard. Please use `PaginatedComments`',
  description: 'List of comments with pagination info',
  fields: () => ({
    comments: {
      type: new GraphQLList(CommentType),
      async resolve(query, args, req) {
        let rows;
        if (query.where.ExpenseId) {
          rows = await req.loaders.Comment.findAllByAttribute('ExpenseId').load(query.where.ExpenseId);
        }
        if (query.where.UpdateId) {
          rows = await req.loaders.Comment.findAllByAttribute('UpdateId').load(query.where.UpdateId);
        }
        return rows.splice(query.offset, query.limit);
      },
    },
    limit: {
      type: GraphQLInt,
      resolve(query) {
        return query.limit;
      },
    },
    offset: {
      type: GraphQLInt,
      resolve(query) {
        return query.offset;
      },
    },
    total: {
      type: GraphQLInt,
      async resolve(query, args, req) {
        if (query.where.ExpenseId) {
          return req.loaders.Comment.countByExpenseId.load(query.where.ExpenseId);
        }
      },
    },
  }),
});

export const CommentType = new GraphQLObjectType({
  name: 'CommentType',
  description: 'This represents a Comment',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(expense) {
          return expense.id;
        },
      },
      createdAt: {
        type: DateString,
        resolve(comment) {
          return comment.createdAt;
        },
      },
      updatedAt: {
        type: DateString,
        resolve(comment) {
          return comment.updatedAt;
        },
      },
      html: {
        type: GraphQLString,
        resolve: commonComment.getStripTagsResolver('html'),
      },
      markdown: {
        type: GraphQLString,
        resolve: commonComment.getStripTagsResolver('markdown'),
      },
      createdByUser: {
        type: UserType,
        resolve(comment) {
          return comment.getUser();
        },
      },
      fromCollective: {
        type: CollectiveInterfaceType,
        resolve: commonComment.fromCollectiveResolver,
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve: commonComment.collectiveResolver,
      },
      expense: {
        type: ExpenseType,
        resolve(comment) {
          if (comment.ExpenseId) {
            return models.Expense.findByPk(comment.ExpenseId);
          }
        },
      },
      update: {
        type: UpdateType,
        resolve(comment) {
          if (comment.UpdateId) {
            return models.Update.findByPk(comment.UpdateId);
          }
        },
      },
    };
  },
});

export const NotificationType = new GraphQLObjectType({
  name: 'NotificationType',
  description: 'This represents a Notification',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(notification) {
          return notification.id;
        },
      },
      channel: {
        description: 'channel to send notification',
        type: GraphQLString,
        resolve(notification) {
          return notification.channel;
        },
      },
      type: {
        description: 'the notification type',
        type: GraphQLString,
        resolve(notification) {
          return notification.type;
        },
      },
      active: {
        description: 'whether or not the notification is active',
        type: GraphQLBoolean,
        resolve(notification) {
          return notification.active;
        },
      },
      webhookUrl: {
        type: GraphQLString,
        resolve(notification) {
          return notification.webhookUrl;
        },
      },
      user: {
        type: UserType,
        resolve(notification) {
          return notification.getUser();
        },
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve(notification, args, req) {
          return req.loaders.Collective.byId.load(notification.CollectiveId);
        },
      },
      createdAt: {
        type: DateString,
        resolve(comment) {
          return comment.createdAt;
        },
      },
      updatedAt: {
        type: DateString,
        resolve(comment) {
          return comment.updatedAt;
        },
      },
    };
  },
});

export const ContributorsStatsType = new GraphQLObjectType({
  name: 'ContributorsStats',
  description: 'Breakdown of contributors per type (ANY/USER/ORGANIZATION/COLLECTIVE)',
  fields: () => {
    return {
      id: {
        type: GraphQLNonNull(GraphQLString),
        description: "We always have to return an id for apollo's caching",
      },
      all: {
        type: GraphQLInt,
        description: 'Total number of contributors',
      },
      users: {
        type: GraphQLInt,
        description: 'Number of individuals',
        resolve(stats) {
          return stats.USER;
        },
      },
      organizations: {
        type: GraphQLInt,
        description: 'Number of organizations',
        resolve(stats) {
          return stats.ORGANIZATION;
        },
      },
      collectives: {
        type: GraphQLInt,
        description: 'Number of collectives',
        resolve(stats) {
          return stats.COLLECTIVE;
        },
      },
    };
  },
});

export const TierStatsType = new GraphQLObjectType({
  name: 'TierStatsType',
  description: 'Stats about a tier',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching
      id: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.id;
        },
      },
      contributors: {
        type: ContributorsStatsType,
        description: 'Breakdown of all the contributors that belongs to this tier.',
        resolve(tier, args, req) {
          return req.loaders.Tier.contributorsStats.load(tier.id);
        },
      },
      totalOrders: {
        description: 'total number of individual orders',
        type: GraphQLInt,
        resolve(tier, args, req) {
          return req.loaders.Tier.totalOrders.load(tier.id);
        },
      },
      totalDonated: {
        description: 'Total amount donated for this tier, in cents.',
        type: GraphQLInt,
        resolve(tier, args, req) {
          return req.loaders.Tier.totalDonated.load(tier.id);
        },
      },
      totalRecurringDonations: {
        description: 'How much money is given for this tier for each tier.interval (monthly/yearly)',
        type: GraphQLInt,
        resolve(tier, args, req) {
          if (tier.interval === intervals.MONTH) {
            return req.loaders.Tier.totalMonthlyDonations.load(tier.id);
          } else if (tier.interval === intervals.YEAR) {
            return req.loaders.Tier.totalYearlyDonations.load(tier.id);
          } else {
            return 0;
          }
        },
      },
      totalDistinctOrders: {
        description: 'total number of people/organizations in this tier',
        type: GraphQLInt,
        resolve(tier, args, req) {
          return req.loaders.Tier.totalDistinctOrders.load(tier.id);
        },
      },
      totalActiveDistinctOrders: {
        description: 'total number of active people/organizations in this tier',
        type: GraphQLInt,
        resolve(tier, args, req) {
          return req.loaders.Tier.totalActiveDistinctOrders.load(tier.id);
        },
      },
      availableQuantity: {
        type: GraphQLInt,
        async resolve(tier, _, req) {
          if (!tier.maxQuantity) {
            return maxInteger;
          } else {
            const result = await req.loaders.Tier.availableQuantity.load(tier.id);
            return result === null ? maxInteger : result;
          }
        },
      },
    };
  },
});

export const TierType = new GraphQLObjectType({
  name: 'Tier',
  description: 'This represents an Tier',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.id;
        },
      },
      slug: {
        type: GraphQLString,
        resolve(tier) {
          return tier.slug;
        },
      },
      type: {
        type: GraphQLString,
        resolve(tier) {
          return tier.type;
        },
      },
      name: {
        type: GraphQLString,
        resolve(tier) {
          return tier.name;
        },
      },
      description: {
        type: GraphQLString,
        resolve(tier) {
          return tier.description;
        },
      },
      longDescription: {
        type: GraphQLString,
        description: 'A long, html-formatted description.',
      },
      hasLongDescription: {
        type: GraphQLBoolean,
        description: 'Returns true if the tier has a long description',
        resolve(tier) {
          return Boolean(tier.longDescription);
        },
      },
      videoUrl: {
        type: GraphQLString,
        description: 'Link to a video (YouTube, Vimeo).',
      },
      button: {
        type: GraphQLString,
        resolve(tier) {
          return tier.button;
        },
      },
      amount: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.amount;
        },
      },
      minimumAmount: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.minimumAmount;
        },
      },
      amountType: {
        type: GraphQLString,
        resolve(tier) {
          return tier.amountType;
        },
      },
      currency: {
        type: GraphQLString,
        resolve(tier) {
          return tier.currency;
        },
      },
      interval: {
        type: GraphQLString,
        resolve(tier) {
          return tier.interval;
        },
      },
      presets: {
        type: new GraphQLList(GraphQLInt),
        resolve(tier) {
          return tier.presets;
        },
      },
      maxQuantity: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.maxQuantity;
        },
      },
      goal: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.goal;
        },
      },
      customFields: {
        type: new GraphQLList(GraphQLJSON),
        resolve(tier) {
          return tier.customFields;
        },
      },
      startsAt: {
        type: DateString,
        resolve(tier) {
          return tier.startsAt;
        },
      },
      endsAt: {
        type: DateString,
        resolve(tier) {
          return tier.endsAt;
        },
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve(tier, args, req) {
          return req.loaders.Collective.byId.load(tier.CollectiveId);
        },
      },
      event: {
        type: CollectiveInterfaceType,
        resolve(tier, args, req) {
          return req.loaders.Collective.byId.load(tier.CollectiveId);
        },
      },
      orders: {
        type: new GraphQLList(OrderType),
        args: {
          isActive: { type: GraphQLBoolean },
          isProcessed: {
            type: GraphQLBoolean,
            description: 'only return orders that have been processed (fulfilled)',
          },
          limit: { type: GraphQLInt },
        },
        resolve(tier, args) {
          const query = {
            limit: args.limit,
          };
          if (args.isProcessed) {
            query.where = { processedAt: { [Op.ne]: null } };
          }
          if (args.isActive) {
            if (tier.interval) {
              query.include = [{ model: models.Subscription, where: { isActive: true } }];
            }
          }
          return tier.getOrders(query);
        },
      },
      contributors: {
        type: new GraphQLList(ContributorType),
        description: 'Returns a list of all the contributors for this tier',
        args: {
          limit: {
            type: GraphQLInt,
            description: 'Maximum number of entries to return',
            defaultValue: 3000,
          },
        },
        resolve(tier, args) {
          return getContributorsForTier(tier.CollectiveId, tier.id, { limit: args.limit });
        },
      },
      stats: {
        type: TierStatsType,
        resolve(tier) {
          return tier;
        },
      },
      data: {
        type: GraphQLJSON,
        resolve(tier) {
          return tier.data;
        },
      },
    };
  },
});

export const StatsOrderType = new GraphQLObjectType({
  name: 'StatsOrderType',
  description: 'Stats about an order',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching (key: __typename+id)
      id: {
        type: GraphQLInt,
        resolve(order) {
          return order.id;
        },
      },
      transactions: {
        description: 'number of transactions for this order (includes past recurring transactions)',
        type: GraphQLInt,
        resolve(order, args, req) {
          return req.loaders.Order.stats.transactions.load(order.id);
        },
      },
      totalTransactions: {
        description: 'total amount of all the transactions for this order (includes past recurring transactions)',
        type: GraphQLInt,
        resolve(order, args, req) {
          return req.loaders.Order.stats.totalTransactions.load(order.id);
        },
      },
    };
  },
});

export const OrderStatusType = new GraphQLEnumType({
  name: 'OrderStatus',
  description: 'Possible statuses for an Order',
  values: Object.keys(orderStatus).reduce((values, key) => ({ ...values, [key]: {} }), {}),
});

export const OrderType = new GraphQLObjectType({
  name: 'OrderType',
  description: 'This is an order (for donations, buying tickets, subscribing to a Tier, pledging to a Collective)',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(order) {
          return order.id;
        },
      },
      idV2: {
        type: GraphQLString,
        resolve(order) {
          return idEncode(order.id, 'order');
        },
      },
      quantity: {
        description: 'quantity of items (defined by Tier)',
        type: GraphQLInt,
        resolve(order) {
          return order.quantity;
        },
      },
      totalAmount: {
        description: "total amount for this order (doesn't include recurring transactions)",
        type: GraphQLInt,
        resolve(order) {
          return order.totalAmount;
        },
      },
      taxAmount: {
        type: GraphQLInt,
        description: 'The amount paid in tax (for example VAT) for this order',
      },
      interval: {
        description: "frequency of the subscription if any (could be either null, 'month' or 'year')",
        type: GraphQLString,
        resolve(order) {
          return order.getSubscription().then(s => (s ? s.interval : null));
        },
      },
      subscription: {
        type: SubscriptionType,
        resolve(order) {
          return order.getSubscription();
        },
      },
      stats: {
        type: StatsOrderType,
        resolve(order) {
          return order;
        },
      },
      createdByUser: {
        type: UserType,
        async resolve(order, args, req) {
          const fromCollective = await order.getFromCollective();
          if (fromCollective.isIncognito && (!req.remoteUser || !req.remoteUser.isAdmin(order.CollectiveId))) {
            return {};
          }

          return order.getCreatedByUser();
        },
      },
      description: {
        description: 'Description of the order that will show up in the invoice',
        type: GraphQLString,
        resolve(order) {
          return order.description;
        },
      },
      publicMessage: {
        description:
          'Custom user message to show with the order, e.g. a special dedication, "in memory of", or to add a custom one liner when RSVP for an event',
        type: GraphQLString,
        resolve(order) {
          return order.publicMessage;
        },
      },
      privateMessage: {
        description: 'Private message for the admins and the host of the collective',
        type: GraphQLString,
        resolve(order) {
          return order.privateMessage; // TODO: should be behind a login check
        },
      },
      fromCollective: {
        description: 'Collective ordering (most of the time it will be the collective of the createdByUser)',
        type: CollectiveInterfaceType,
        async resolve(order, args, req) {
          if (!order.FromCollectiveId) {
            console.warn('There is no FromCollectiveId for order', order.id);
            return null;
          }
          const fromCollective = await req.loaders.Collective.byId.load(order.FromCollectiveId);
          if (req.remoteUser && req.remoteUser.isAdmin(order.CollectiveId)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_INCOGNITO_ACCOUNT_DETAILS, fromCollective.id);
          }
          return fromCollective;
        },
      },
      collective: {
        description: 'Collective that receives the order',
        type: CollectiveInterfaceType,
        resolve(order, args, req) {
          return req.loaders.Collective.byId.load(order.CollectiveId);
        },
      },
      tier: {
        type: TierType,
        resolve(order) {
          return order.getTier();
        },
      },
      paymentMethod: {
        description:
          'Payment method used to pay for the order. The paymentMethod is also attached to individual transactions since a credit card can change over the lifetime of a subscription.',
        type: PaymentMethodType,
        resolve(order, args, req) {
          if (!req.remoteUser) {
            return null;
          }
          return order.getPaymentMethodForUser(req.remoteUser);
        },
      },
      transactions: {
        description: 'transactions for this order ordered by createdAt DESC',
        type: new GraphQLList(TransactionInterfaceType),
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          type: {
            type: GraphQLString,
            description: 'type of transaction (DEBIT/CREDIT)',
          },
        },
        resolve(order, args, req) {
          const query = {
            where: {},
            limit: args.limit || 10,
            offset: args.offset || 0,
          };
          if (args.type) {
            query.where.type = args.type;
          }
          return req.loaders.Transaction.findByOrderId(query).load(order.id);
        },
      },
      currency: {
        type: GraphQLString,
        resolve(order) {
          return order.currency;
        },
      },
      createdAt: {
        type: DateString,
        resolve(order) {
          return order.createdAt;
        },
      },
      updatedAt: {
        type: DateString,
        resolve(order) {
          return order.updatedAt;
        },
      },
      // TODO: two fields below (isPastDue & isSubscriptionActive) an possibly be combined as one
      // Leaving them separate for now to make it easy for logged in vs logged out data
      isPastDue: {
        description: 'Whether this subscription is past due or not',
        type: GraphQLBoolean,
        resolve(order, args, req) {
          // if logged out experience, always return false
          if (!req.remoteUser) {
            return false;
          }
          // otherwise, check if this user has permission
          return order
            .getSubscriptionForUser(req.remoteUser)
            .then(subscription => subscription && subscription.isActive && subscription.chargeRetryCount > 0);
        },
      },
      // Note this field is public
      isSubscriptionActive: {
        description: 'If there is a subscription, is it active?',
        type: GraphQLBoolean,
        resolve(order) {
          return order.getSubscription().then(s => (s ? s.isActive : null));
        },
      },
      status: {
        description: 'Current status for an order',
        type: OrderStatusType,
        resolve(order) {
          return order.status;
        },
      },
      data: {
        type: GraphQLJSON,
        description: 'Additional information on order: tax and custom fields',
        resolve(order) {
          return pick(order.data, ['tax', 'customData', 'isFeesOnTop', 'platformFee']) || null;
        },
      },
      stripeError: {
        type: StripeErrorType,
        resolve(order) {
          return order.stripeError;
        },
      },
    };
  },
});

// Note: we assume that all of this data is publicly accessible without a login
export const ConnectedAccountType = new GraphQLObjectType({
  name: 'ConnectedAccountType',
  description: 'Sanitized ConnectedAccount Info (ConnectedAccount model)',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(ca) {
          return ca.id;
        },
      },
      service: {
        type: GraphQLString,
        resolve(ca) {
          return ca.service;
        },
      },
      username: {
        type: GraphQLString,
        resolve(ca, args, req) {
          // Services which we consider the username to be public
          const publicServices = ['github', 'twitter'];
          if (req.remoteUser && req.remoteUser.isAdmin(ca.CollectiveId)) {
            return ca.username;
          } else if (publicServices.includes(ca.service)) {
            return ca.username;
          } else {
            return null;
          }
        },
      },
      settings: {
        type: GraphQLJSON,
        resolve(ca) {
          return ca.settings;
        },
      },
      createdAt: {
        type: DateString,
        resolve(ca) {
          return ca.createdAt;
        },
      },
      updatedAt: {
        type: DateString,
        resolve(ca) {
          return ca.updatedAt;
        },
      },
    };
  },
});

// TODO: Put behind a login token
export const PaymentMethodType = new GraphQLObjectType({
  name: 'PaymentMethodType',
  description: 'Sanitized PaymentMethod Info (PaymentMethod model)',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(paymentMethod) {
          return paymentMethod.id;
        },
      },
      uuid: {
        type: GraphQLString,
        resolve(paymentMethod, _, req) {
          const isUnconfirmedVirtualCard = paymentMethod.type === 'virtualcard' && !paymentMethod.confirmedAt;
          if (isUnconfirmedVirtualCard && (!req.remoteUser || !req.remoteUser.isAdmin(paymentMethod.CollectiveId))) {
            return null;
          }

          return paymentMethod.uuid;
        },
      },
      createdAt: {
        type: DateString,
        resolve(paymentMethod) {
          return paymentMethod.createdAt;
        },
      },
      isConfirmed: {
        type: GraphQLBoolean,
        description: 'Will be true for virtual card if claimed. Always true for other payment methods.',
        resolve(paymentMethod) {
          return paymentMethod.isConfirmed();
        },
      },
      expiryDate: {
        type: DateString,
        resolve(paymentMethod) {
          return paymentMethod.expiryDate;
        },
      },
      service: {
        type: GraphQLString,
        resolve(paymentMethod) {
          return paymentMethod.service;
        },
      },
      batch: {
        type: GraphQLString,
        description: 'To group multiple payment methods. Used for Gift Cards',
      },
      SourcePaymentMethodId: {
        type: GraphQLInt,
        deprecationReason: '2020-09-28: Not used',
        resolve(paymentMethod) {
          return paymentMethod.SourcePaymentMethodId;
        },
      },
      type: {
        type: GraphQLString,
        resolve(paymentMethod) {
          return paymentMethod.type;
        },
      },
      data: {
        type: GraphQLJSON,
        resolve(paymentMethod, _, req) {
          if (!paymentMethod.data) {
            return null;
          }

          // Protect and whitelist fields for virtualcard
          if (paymentMethod.type === 'virtualcard') {
            if (!req.remoteUser || !req.remoteUser.isAdmin(paymentMethod.CollectiveId)) {
              return null;
            }
            return pick(paymentMethod.data, ['email']);
          }

          const data = paymentMethod.data;
          // white list fields to send back; removes fields like CustomerIdForHost
          const dataSubset = {
            fullName: data.fullName,
            expMonth: data.expMonth,
            expYear: data.expYear,
            brand: data.brand,
            country: data.country,
            last4: data.last4,
          };
          return dataSubset;
        },
      },
      name: {
        // last 4 digit of card number for Stripe
        type: GraphQLString,
        resolve(paymentMethod, _, req) {
          if (
            paymentMethod.service === PAYMENT_METHOD_SERVICE.PAYPAL &&
            paymentMethod.type === PAYMENT_METHOD_TYPES.ADAPTIVE
          ) {
            return req.remoteUser?.isAdmin(paymentMethod.CollectiveId) ? paymentMethod.name : null;
          } else {
            return paymentMethod.name;
          }
        },
      },
      description: {
        type: GraphQLString,
        resolve(paymentMethod) {
          return paymentMethod.description;
        },
      },
      primary: {
        type: GraphQLBoolean,
        resolve(paymentMethod) {
          return paymentMethod.primary;
        },
      },
      monthlyLimitPerMember: {
        type: GraphQLInt,
        resolve(paymentMethod) {
          return paymentMethod.monthlyLimitPerMember;
        },
      },
      initialBalance: {
        type: GraphQLInt,
        resolve(paymentMethod) {
          return paymentMethod.initialBalance;
        },
      },
      balance: {
        type: GraphQLInt,
        description: 'Returns the balance in the currency of this paymentMethod',
        async resolve(paymentMethod, args, req) {
          const balance = await paymentMethod.getBalanceForUser(req.remoteUser);
          return balance.amount;
        },
      },
      collective: {
        type: CollectiveInterfaceType,
        resolve(paymentMethod, args, req) {
          return req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
        },
      },
      emitter: {
        type: CollectiveInterfaceType,
        async resolve(paymentMethod, args, req) {
          // TODO: could we have a getter for SourcePaymentMethod?
          if (paymentMethod.SourcePaymentMethodId) {
            const sourcePaymentMethod = await models.PaymentMethod.findByPk(paymentMethod.SourcePaymentMethodId);
            if (sourcePaymentMethod) {
              return req.loaders.Collective.byId.load(sourcePaymentMethod.CollectiveId);
            }
          }
        },
      },
      limitedToTags: {
        type: GraphQLJSON,
        resolve(paymentMethod) {
          return paymentMethod.limitedToTags;
        },
      },
      limitedToCollectiveIds: {
        type: new GraphQLList(GraphQLInt),
        deprecationReason: '2020-08-11: This field does not exist anymore',
        resolve() {
          return null;
        },
      },
      limitedToHostCollectiveIds: {
        type: new GraphQLList(GraphQLInt),
        resolve(paymentMethod) {
          return paymentMethod.limitedToHostCollectiveIds;
        },
      },
      orders: {
        type: new GraphQLList(OrderType),
        args: {
          hasActiveSubscription: {
            type: GraphQLBoolean,
            description: 'Only returns orders that have an active subscription (monthly/yearly)',
          },
        },
        resolve(paymentMethod, args) {
          const query = {};
          if (args.hasActiveSubscription) {
            query.where = { status: { [Op.or]: [orderStatus.ACTIVE, orderStatus.ERROR] } };
            query.include = [
              {
                model: models.Subscription,
                where: { isActive: true },
                required: true,
              },
            ];
          }
          return paymentMethod.getOrders(query);
        },
      },
      fromCollectives: {
        type: CollectiveSearchResultsType,
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        description:
          'Get the list of collectives that used this payment method. Useful to select the list of a backers for which the host has manually added funds.',
        async resolve(paymentMethod, args) {
          const res = await models.Transaction.findAll({
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('FromCollectiveId')), 'FromCollectiveId']],
            where: { PaymentMethodId: paymentMethod.id, type: 'CREDIT' },
          });
          const FromCollectiveIds = res.map(r => r.dataValues.FromCollectiveId);
          const result = await models.Collective.findAndCountAll({
            where: { id: { [Op.in]: FromCollectiveIds } },
          });
          const { count, rows } = result;
          return {
            total: count,
            collectives: rows,
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      currency: {
        type: GraphQLString,
        resolve(paymentMethod) {
          return paymentMethod.currency;
        },
      },
      stripeError: {
        type: StripeErrorType,
        resolve(paymentMethod) {
          return paymentMethod.stripeError;
        },
      },
    };
  },
});

// TODO: Do we even need this type? It's 1:1 mapping with Order.
// Already linked interval and isActive directly in Order table
export const SubscriptionType = new GraphQLObjectType({
  name: 'Subscription',
  description: 'Subscription model',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(s) {
          return s.id;
        },
      },
      amount: {
        type: GraphQLInt,
        resolve(s) {
          return s.amount;
        },
      },
      currency: {
        type: GraphQLString,
        resolve(s) {
          return s.currency;
        },
      },
      interval: {
        type: GraphQLString,
        resolve(s) {
          return s.interval;
        },
      },
      stripeSubscriptionId: {
        type: GraphQLString,
        resolve(s) {
          return s.stripeSubscriptionId;
        },
      },
      isActive: {
        type: GraphQLBoolean,
        resolve(s) {
          return s.isActive;
        },
      },
    };
  },
});

export const ExpenseStatusType = new GraphQLEnumType({
  name: 'ExpenseStatus',
  description: 'Possible statuses for an Expense',
  values: Object.keys(status).reduce((values, key) => ({ ...values, [key]: {} }), {}),
});

export const UserInputType = new GraphQLInputObjectType({
  name: 'UserInput',
  description: 'Create and edit options for users',
  fields: {
    email: {
      type: GraphQLString,
      description: 'User email address',
    },
    firstName: {
      type: GraphQLString,
      description: 'User first name',
    },
    lastName: {
      type: GraphQLString,
      description: 'User last name',
    },
  },
});

export const OrderDirectionType = new GraphQLEnumType({
  name: 'OrderDirection',
  description: 'Possible directions in which to order a list of items when provided an orderBy argument.',
  values: {
    ASC: {},
    DESC: {},
  },
});

export const OrderByType = new GraphQLInputObjectType({
  name: 'OrderByType',
  description: 'Ordering options',
  fields: {
    field: {
      description: '',
      defaultValue: 'createdAt',
      type: new GraphQLEnumType({
        name: 'OrderByField',
        description: 'Properties by which results can be ordered.',
        values: {
          createdAt: {
            description: 'Order result by creation time.',
          },
          updatedAt: {
            description: 'Order result by updated time.',
          },
        },
      }),
    },
    direction: {
      description: 'The ordering direction',
      defaultValue: 'DESC',
      type: OrderDirectionType,
    },
  },
});

OrderByType.defaultValue = Object.entries(OrderByType.getFields()).reduce(
  (values, [key, value]) => ({
    ...values,
    [key]: value.defaultValue,
  }),
  {},
);

export const PaginatedExpensesType = new GraphQLObjectType({
  name: 'PaginatedExpenses',
  description: 'A list of expenses with pagination info',
  fields: {
    expenses: { type: new GraphQLList(ExpenseType) },
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
    total: { type: GraphQLInt },
  },
});

export const PaymentMethodBatchInfo = new GraphQLObjectType({
  name: 'PaymentMethodBatchInfo',
  description: 'Provides rich information about a payment methods batch',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) }, // For caching
    collectiveId: { type: new GraphQLNonNull(GraphQLInt) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
    type: { type: new GraphQLNonNull(GraphQLString) },
    name: {
      type: GraphQLString,
      description: 'The batch name, or null for unbatched payment methods',
    },
  },
});

export const PaginatedPaymentMethodsType = paginatedList(PaymentMethodType, 'PaymentMethod', 'paymentMethods');

export const StripeErrorType = new GraphQLObjectType({
  name: 'StripeError',
  fields: () => {
    return {
      message: {
        type: GraphQLString,
        resolve(error) {
          return error.message;
        },
      },
      account: {
        type: GraphQLString,
        resolve(error) {
          return error.account;
        },
      },
      response: {
        type: GraphQLJSON,
        resolve(error) {
          return error.response;
        },
      },
    };
  },
});
