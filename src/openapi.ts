import { z } from 'zod';
import { loginSchema, refreshSchema, registerSchema } from './modules/auth/schemas';
import { campaignInput, decisionInput, listQuery, statusFilter, submitInput, transitionInput } from './modules/campaigns/schemas';
import { accessTokenBody, createContribution } from './modules/contributions/schemas';
import { listNotifications, preferencesInput } from './modules/notifications/schemas';
import { deliveryInput } from './modules/reports/schemas';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Auth = 'none' | 'bearer' | 'optional' | 'accessToken';

export interface Operation {
  method: Method;
  path: string; // OpenAPI style, for example /campaigns/{id}
  tag: string;
  summary: string;
  description?: string;
  auth?: Auth;
  body?: z.ZodType;
  query?: z.ZodType;
  errors?: number[];
  idempotencyKey?: boolean;
  success?: number;
}

// Single source of truth for the documentation. Request schemas come from the same Zod
// schemas the server validates with, so the docs cannot drift from the real rules.
export const operations: Operation[] = [
  { method: 'get', path: '/health', tag: 'System', summary: 'Liveness and database check' },

  { method: 'post', path: '/auth/register', tag: 'Auth', summary: 'Create an account', body: registerSchema, errors: [400, 409], success: 201 },
  { method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Sign in', body: loginSchema, errors: [400, 401], description: 'Failed sign-ins return the same message whether or not the email exists.' },
  { method: 'post', path: '/auth/refresh', tag: 'Auth', summary: 'Exchange a refresh token for a new pair', body: refreshSchema, errors: [400, 401], description: 'Each refresh token works once. Reusing one revokes every session for that user.' },
  { method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Revoke a refresh token', body: refreshSchema, errors: [400], success: 204 },
  { method: 'get', path: '/auth/me', tag: 'Auth', summary: 'Current user', auth: 'bearer', errors: [401] },

  { method: 'get', path: '/campaigns', tag: 'Campaigns', summary: 'Browse published campaigns', query: listQuery, errors: [400], description: 'Only campaigns that were approved and opened for backing appear. Money is in integer cents. Reach is an estimated range.' },
  { method: 'get', path: '/campaigns/{id}', tag: 'Campaigns', summary: 'Campaign detail', auth: 'optional', errors: [404], description: 'Drafts and campaigns in review are visible only to their owner and reviewers. Private fields are removed for everyone else.' },
  { method: 'post', path: '/campaigns', tag: 'Campaigns', summary: 'Create a draft', auth: 'bearer', body: campaignInput, errors: [400, 401], success: 201, description: 'A draft may be incomplete. The funding goal has no default: the creator sets it.' },
  { method: 'patch', path: '/campaigns/{id}', tag: 'Campaigns', summary: 'Edit a draft', auth: 'bearer', body: campaignInput, errors: [400, 401, 404, 409], description: 'Allowed only while the campaign is draft or changes_requested. Sending story or sources replaces the whole list.' },
  { method: 'post', path: '/campaigns/{id}/submit', tag: 'Campaigns', summary: 'Submit for review', auth: 'bearer', body: submitInput, errors: [400, 401, 404, 409], description: 'Lists every missing required field at once.' },
  { method: 'post', path: '/campaigns/{id}/cancel', tag: 'Campaigns', summary: 'Cancel a draft', auth: 'bearer', errors: [401, 404, 409] },
  { method: 'get', path: '/campaigns/{id}/audit', tag: 'Campaigns', summary: 'Status history', auth: 'bearer', errors: [401, 403, 404], description: 'Owner and reviewers only.' },
  { method: 'get', path: '/campaigns/{id}/report', tag: 'Reports', summary: 'Funds, estimate and measured delivery', auth: 'bearer', errors: [401, 404], description: 'Estimates and measured delivery are separate sections and never combined. Delivery is unavailable until a reviewer records it.' },

  { method: 'post', path: '/campaigns/{id}/follow', tag: 'Engagement', summary: 'Follow a published campaign', auth: 'bearer', errors: [401, 404], description: 'Safe to repeat.' },
  { method: 'delete', path: '/campaigns/{id}/follow', tag: 'Engagement', summary: 'Unfollow', auth: 'bearer', errors: [401] },
  { method: 'post', path: '/campaigns/{id}/bookmark', tag: 'Engagement', summary: 'Save a published campaign', auth: 'bearer', errors: [401, 404] },
  { method: 'delete', path: '/campaigns/{id}/bookmark', tag: 'Engagement', summary: 'Remove a saved campaign', auth: 'bearer', errors: [401] },

  { method: 'post', path: '/campaigns/{id}/contributions', tag: 'Payments', summary: 'Contribute toward promoting a campaign', auth: 'optional', body: createContribution, errors: [400, 404, 409, 422], idempotencyKey: true, success: 201,
    description: 'Guests may contribute. Money is in cents. The response includes an access token once, which is needed to confirm, cancel or view the receipt as a guest. Send an Idempotency-Key header so a retry cannot charge twice.' },
  { method: 'get', path: '/campaigns/{id}/backers', tag: 'Payments', summary: 'Backer count and public names', errors: [404], description: 'Names appear only for people who chose to be public. Amounts are never shown.' },
  { method: 'get', path: '/contributions/{id}', tag: 'Payments', summary: 'Receipt', auth: 'accessToken', errors: [404], description: 'Visible to the payer when signed in, or to anyone holding the X-Access-Token.' },
  { method: 'post', path: '/contributions/{id}/confirm', tag: 'Payments', summary: 'Confirm a pending payment', body: accessTokenBody, errors: [400, 404, 409], description: 'Counts toward funding only now. If the campaign closed in the meantime, the payment fails and nobody is charged.' },
  { method: 'post', path: '/contributions/{id}/cancel', tag: 'Payments', summary: 'Cancel a pending payment', body: accessTokenBody, errors: [400, 404, 409] },

  { method: 'get', path: '/me/campaigns', tag: 'Me', summary: 'My campaigns', auth: 'bearer', query: statusFilter, errors: [401] },
  { method: 'get', path: '/me/drafts', tag: 'Me', summary: 'My drafts and campaigns needing changes', auth: 'bearer', errors: [401] },
  { method: 'get', path: '/me/contributions', tag: 'Me', summary: 'Payment history, including attempts that did not succeed', auth: 'bearer', errors: [401] },
  { method: 'get', path: '/me/follows', tag: 'Me', summary: 'Campaigns I follow', auth: 'bearer', errors: [401] },
  { method: 'get', path: '/me/bookmarks', tag: 'Me', summary: 'Campaigns I saved', auth: 'bearer', errors: [401] },
  { method: 'get', path: '/me/notifications', tag: 'Notifications', summary: 'Notification feed', auth: 'bearer', query: listNotifications, errors: [400, 401], description: 'Categories switched off in the preferences are hidden here and from the unread count.' },
  { method: 'get', path: '/me/notifications/unread-count', tag: 'Notifications', summary: 'Unread count for a badge', auth: 'bearer', errors: [401] },
  { method: 'post', path: '/me/notifications/read-all', tag: 'Notifications', summary: 'Mark everything as read', auth: 'bearer', errors: [401] },
  { method: 'post', path: '/me/notifications/{id}/read', tag: 'Notifications', summary: 'Mark one as read', auth: 'bearer', errors: [401, 404] },
  { method: 'get', path: '/me/notification-preferences', tag: 'Notifications', summary: 'Which categories I see', auth: 'bearer', errors: [401] },
  { method: 'put', path: '/me/notification-preferences', tag: 'Notifications', summary: 'Change which categories I see', auth: 'bearer', body: preferencesInput, errors: [400, 401] },

  { method: 'get', path: '/admin/campaigns', tag: 'Reviewer', summary: 'All campaigns', auth: 'bearer', query: statusFilter, errors: [401, 403] },
  { method: 'post', path: '/admin/campaigns/{id}/decision', tag: 'Reviewer', summary: 'Approve, request changes or reject', auth: 'bearer', body: decisionInput, errors: [400, 401, 403, 404, 409], description: 'Requesting changes or rejecting needs a note. Approving can also open the campaign for backing.' },
  { method: 'post', path: '/admin/campaigns/{id}/transition', tag: 'Reviewer', summary: 'Move a campaign through later lifecycle steps', auth: 'bearer', body: transitionInput, errors: [400, 401, 403, 404, 409], description: 'Funding completion does not launch ads: promoting needs distribution preparation, confirmed payments and ad setup.' },
  { method: 'post', path: '/admin/campaigns/{id}/refunds', tag: 'Reviewer', summary: 'Refund every payment of a campaign in refund_pending', auth: 'bearer', errors: [401, 403, 404, 409] },
  { method: 'post', path: '/admin/campaigns/{id}/delivery-reports', tag: 'Reviewer', summary: 'Record measured delivery from the ad platform', auth: 'bearer', body: deliveryInput, errors: [400, 401, 403, 404, 409], success: 201 }
];

const ERROR_TEXT: Record<number, string> = {
  400: 'Validation failed. The error lists each invalid field.',
  401: 'Not signed in, or the token is invalid.',
  403: 'Signed in, but not allowed to do this.',
  404: 'Not found.',
  409: 'Conflicts with the current state, for example an illegal status change.',
  422: 'The Idempotency-Key was already used for a different request.'
};

const json = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) } });

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of operations) {
    const parameters: unknown[] = [...(op.path.match(/\{(\w+)\}/g) ?? []).map(p => ({
      name: p.slice(1, -1), in: 'path', required: true, schema: { type: 'string', format: 'uuid' }
    }))];
    if (op.query) {
      const js = z.toJSONSchema(op.query, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, unknown> };
      for (const [name, schema] of Object.entries(js.properties ?? {})) parameters.push({ name, in: 'query', required: false, schema });
    }
    if (op.idempotencyKey) {
      parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Retrying with the same key returns the original payment instead of charging twice.', schema: { type: 'string', minLength: 8, maxLength: 80 } });
    }
    if (op.auth === 'accessToken') {
      parameters.push({ name: 'X-Access-Token', in: 'header', required: false, description: 'Lets a guest payer view their receipt.', schema: { type: 'string' } });
    }

    const status = String(op.success ?? 200);
    const responses: Record<string, unknown> = {
      [status]: { description: status === '204' ? 'Done, no content.' : 'Success.', ...(status === '204' ? {} : { content: { 'application/json': { schema: { type: 'object' } } } }) }
    };
    for (const code of op.errors ?? []) {
      responses[String(code)] = { description: ERROR_TEXT[code], content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
    }

    const security = op.auth === 'bearer' ? [{ bearerAuth: [] }] : op.auth === 'optional' ? [{}, { bearerAuth: [] }] : undefined;
    (paths[op.path] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: json(op.body) } } : {}),
      ...(security ? { security } : {}),
      responses
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Amplify API',
      version: '1.0.0',
      description: [
        'Backend for Amplify, a community-funded message amplification platform.',
        '',
        'A contribution pays for advertising distribution. It is not a donation to the creator or the cause.',
        'Money is always integer cents. Reach is always an estimated range. Funding completion does not launch ads.',
        'The payment provider is simulated: nothing is charged.'
      ].join('\n')
    },
    tags: ['System', 'Auth', 'Campaigns', 'Engagement', 'Payments', 'Me', 'Notifications', 'Reports', 'Reviewer'].map(name => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from /auth/login or /auth/register.' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', example: 'validation_failed' },
                message: { type: 'string' },
                fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Field name to problem, for validation errors.' }
              }
            }
          }
        }
      }
    }
  };
}
