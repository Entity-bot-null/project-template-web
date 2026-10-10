import { api } from '../api/client';
import { call } from '../api/errors';
import { LoadFailed } from '../components/LoadFailed';
import { useLoader } from '../hooks/useLoader';

const PAGE_SIZE = 50;

const fetchUsers = () => call(api.GET('/api/users', { params: { query: { limit: PAGE_SIZE } } }));

/** Admins only: the route is guarded here and, authoritatively, by the API. */
export function AdminUsersPage() {
  const { state, retry } = useLoader(fetchUsers);
  return (
    <section className="stack" aria-labelledby="users-heading">
      <h1 id="users-heading">Users</h1>
      {state.kind === 'loading' && <p role="status">Loading users…</p>}
      {state.kind === 'failed' && (
        <LoadFailed
          failure={state.failure}
          retrying={state.retrying}
          onRetry={() => void retry()}
        />
      )}
      {state.kind === 'loaded' && (
        <>
          <p>
            Showing {state.data.items.length} of {state.data.total}.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{user.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
