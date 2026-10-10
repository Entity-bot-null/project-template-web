// Account roles, least to most privileged. The database enum (Role in
// prisma/schema.prisma) must list the same values; a unit spec checks it.
export const ROLES = ['member', 'admin'] as const;

export type Role = (typeof ROLES)[number];

/** The authenticated caller, as the access token describes it. */
export interface RequestUser {
  id: string;
  role: Role;
}
