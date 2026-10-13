import { z } from 'zod';
import { pageOf } from '../../common/pagination.js';
import { ROLES } from '../../common/types/request-user.js';

export const CreateInvitationSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()).meta({ format: 'email' }),
  role: z.enum(ROLES),
});
export type CreateInvitationDto = z.infer<typeof CreateInvitationSchema>;

// A pending invitation as administrators see it. Never its token (only the
// hash exists) nor anything about the person beyond the address invited.
export const InvitationSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(ROLES),
  /** The administrator who invited; null once that account is gone. */
  invitedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  /** When the link stops working; null while the message has not gone out. */
  expiresAt: z.iso.datetime().nullable(),
});
export type InvitationResponse = z.infer<typeof InvitationSchema>;

export const InvitationPageSchema = pageOf(InvitationSchema);
