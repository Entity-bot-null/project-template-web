import { useState } from 'react';
import { api } from '../api/client';
import { call, describeFailure, failedField } from '../api/errors';
import { useCapabilities } from '../auth/capabilities';
import type { Role } from '../auth/types';
import { emailError } from '../auth/validation';
import { Alert } from '../components/Alert';
import { LoadFailed } from '../components/LoadFailed';
import { TextField } from '../components/TextField';
import { useFocusFirstInvalid } from '../hooks/useFocusFirstInvalid';
import { useLoader } from '../hooks/useLoader';

const PAGE_SIZE = 50;

const fetchInvitations = () =>
  call(api.GET('/api/admin/invitations', { params: { query: { limit: PAGE_SIZE } } }));

type InvitationPage = Extract<Awaited<ReturnType<typeof fetchInvitations>>, { ok: true }>['data'];

/**
 * Admins only: the route is guarded here and, authoritatively, by the API.
 * Inviting sends a link to the address; the account exists once the person
 * accepts it with their own name and password, with the role chosen here.
 */
export function AdminInvitationsPage() {
  const capabilities = useCapabilities();
  // Bumped after an invitation is sent or revoked: the list loads again.
  const [version, setVersion] = useState(0);
  const { state, retry } = useLoader(fetchInvitations, version);
  // The last list loaded stays on screen while the next one loads (after an
  // invitation is sent or revoked), instead of flashing a loading message.
  const [shown, setShown] = useState<InvitationPage | null>(null);
  // Adjusted while rendering, as React recommends for state derived from a
  // change: no extra render pass through an effect.
  if (state.kind === 'loaded' && state.data !== shown) setShown(state.data);
  const current = state.kind === 'loaded' ? state.data : shown;
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // A row's action on its way: every row's buttons wait for it (no double send).
  const [acting, setActing] = useState(false);

  const act = (action: () => Promise<unknown>) => {
    setActing(true);
    void action().finally(() => {
      setActing(false);
    });
  };

  const changed = (message: string) => {
    setNotice(message);
    setFailure(null);
    setVersion((current) => current + 1);
  };

  async function send(email: string, role: Role): Promise<boolean> {
    setNotice(null);
    setFailure(null);
    const result = await call(api.POST('/api/admin/invitations', { body: { email, role } }));
    if (result.ok) {
      changed(`Invitation sent to ${email}.`);
      return true;
    }
    const { status } = result.failure;
    setFailure(
      failedField(result.failure) === 'email'
        ? `${email} is not a valid address.`
        : status === 409
          ? `${email} already has an account.`
          : status === 429
            ? `${email} got a message moments ago: invite it again in a minute.`
            : status === 503
              ? 'Email is off here: create accounts with the user:create command.'
              : describeFailure(result.failure),
    );
    return false;
  }

  async function revoke(id: string, email: string) {
    setNotice(null);
    const result = await call(
      api.DELETE('/api/admin/invitations/{id}', { params: { path: { id } } }),
    );
    if (result.ok || result.failure.status === 404) {
      changed(`Invitation to ${email} revoked.`);
    } else {
      setFailure(describeFailure(result.failure));
    }
  }

  return (
    <section className="stack" aria-labelledby="invitations-heading">
      <h1 id="invitations-heading">Invitations</h1>
      {notice !== null && <Alert tone="info">{notice}</Alert>}
      {failure !== null && <Alert>{failure}</Alert>}
      {capabilities?.invitations === false && (
        <Alert tone="info">
          Email is off here: invitations cannot be sent. Create accounts with the user:create
          command.
        </Alert>
      )}
      {/* Offered unless the deployment says email is off: while that is
          unknown, the API's answer (503) still tells. */}
      {capabilities?.invitations !== false && <InviteForm onSend={send} />}
      <h2>Pending</h2>
      {state.kind === 'loading' && shown === null && <p role="status">Loading invitations…</p>}
      {state.kind === 'failed' && (
        <LoadFailed
          failure={state.failure}
          retrying={state.retrying}
          onRetry={() => void retry()}
        />
      )}
      {state.kind !== 'failed' && current !== null && (
        <InvitationList
          page={current}
          busy={state.kind === 'loading'}
          acting={acting}
          onSend={(email, role) => {
            act(() => send(email, role));
          }}
          onRevoke={(id, email) => {
            act(() => revoke(id, email));
          }}
        />
      )}
    </section>
  );
}

function InviteForm({ onSend }: { onSend: (email: string, role: Role) => Promise<boolean> }) {
  const { formRef, focusInvalid } = useFocusFirstInvalid();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const problem = emailError(email);
    setError(problem);
    if (problem !== null) return;
    setSubmitting(true);
    const sent = await onSend(email.trim(), role);
    setSubmitting(false);
    if (sent) setEmail('');
  }

  return (
    <form
      className="stack auth-form"
      noValidate
      aria-labelledby="invite-heading"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        void submit().then(focusInvalid);
      }}
    >
      <h2 id="invite-heading">Invite someone</h2>
      <TextField
        label="Email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={setEmail}
        error={error}
      />
      <div className="field">
        <label htmlFor="invite-role">Role</label>
        <select
          id="invite-role"
          value={role}
          onChange={(event) => {
            setRole(event.target.value === 'admin' ? 'admin' : 'member');
          }}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <button type="submit" disabled={submitting}>
        {submitting ? 'Sending…' : 'Send invitation'}
      </button>
    </form>
  );
}

function InvitationList({
  page,
  busy,
  acting,
  onSend,
  onRevoke,
}: {
  page: InvitationPage;
  busy: boolean;
  /** An action of a row is on its way: the buttons wait. */
  acting: boolean;
  onSend: (email: string, role: Role) => void;
  onRevoke: (id: string, email: string) => void;
}) {
  if (page.items.length === 0) return <p aria-busy={busy}>No pending invitations.</p>;
  return (
    <table aria-busy={busy}>
      <thead>
        <tr>
          <th scope="col">Email</th>
          <th scope="col">Role</th>
          <th scope="col">Invited by</th>
          <th scope="col">Link works until</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {page.items.map((invitation) => (
          <tr key={invitation.id}>
            <td>{invitation.email}</td>
            <td>{invitation.role}</td>
            <td>{invitation.invitedBy?.name ?? 'Unknown'}</td>
            <td>
              {invitation.expiresAt === null
                ? 'Sending…'
                : new Date(invitation.expiresAt).toLocaleString()}
            </td>
            <td>
              {/* Names start with the visible word, as speech input expects. */}
              <button
                type="button"
                className="link-button"
                disabled={acting}
                aria-label={`Send again to ${invitation.email}`}
                onClick={() => {
                  onSend(invitation.email, invitation.role);
                }}
              >
                Send again
              </button>{' '}
              <button
                type="button"
                className="link-button"
                disabled={acting}
                aria-label={`Revoke the invitation to ${invitation.email}`}
                onClick={() => {
                  onRevoke(invitation.id, invitation.email);
                }}
              >
                Revoke
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
