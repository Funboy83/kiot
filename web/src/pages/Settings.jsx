import { useState, useEffect } from 'preact/hooks';
import { post, put, dateTime } from '../api.js';
import { useApp, useFetch, ErrorBox, Modal, toast } from '../components/ui.jsx';

export default function Settings() {
  const { user, settings, reloadSettings } = useApp();
  const [form, setForm] = useState(settings);
  const [error, setError] = useState(null);
  const users = useFetch(user.role === 'admin' ? '/users' : null);
  const [editing, setEditing] = useState(null);
  useEffect(() => setForm(settings), [settings]);
  if (user.role !== 'admin') return <div class="empty">Only an admin can change settings.</div>;

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await put('/settings', form);
      await reloadSettings();
      toast('Settings saved');
    } catch (err) {
      setError(err);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });

  return (
    <div class="stack" style="max-width:900px">
      <h1>Settings</h1>
      <form class="card stack" onSubmit={save}>
        <h2>Store</h2>
        <ErrorBox error={error} />
        <div class="form-grid">
          <label class="field"><span>Store name</span><input value={form.store_name} onInput={set('store_name')} /></label>
          <label class="field"><span>Timezone (sets which day a sale counts on)</span><input list="tz" value={form.timezone} onInput={set('timezone')} />
            <datalist id="tz">{['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Asia/Ho_Chi_Minh', 'UTC'].map((z) => <option key={z} value={z} />)}</datalist>
          </label>
          <label class="field"><span>Currency code</span><input value={form.currency} onInput={set('currency')} maxLength={3} /></label>
          <label class="field"><span>App mode</span>
            <select value={form.ui_mode || 'simple'} onChange={set('ui_mode')}>
              <option value="simple">Simple: everyday screens only</option>
              <option value="advanced">Advanced: orders, inventory, reports and every option</option>
            </select>
          </label>
        </div>
        <div class="row"><span class="spacer" /><button class="primary">Save</button></div>
      </form>

      <div class="card flush">
        <div class="row" style="padding:16px 16px 0"><h2 style="margin:0">Staff accounts</h2><span class="spacer" /><button onClick={() => setEditing({})}>＋ Add staff</button></div>
        <div class="table-wrap" style="margin-top:12px">
          <table class="table">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th class="hide-sm">Created</th><th /></tr></thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}>
                  <td>{u.name} {!u.active && <span class="badge bad">Disabled</span>}</td>
                  <td>{u.username}</td>
                  <td>{u.role === 'admin' ? 'Admin' : 'Cashier'}</td>
                  <td class="hide-sm muted">{dateTime(u.created_at).slice(0, 10)}</td>
                  <td><button class="icon-btn" onClick={() => setEditing(u)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="muted small" style="padding:0 16px 8px">Cashiers can sell, manage products, stock and customers. Only admins see profit reports and settings.</p>
      </div>
      {editing && <UserModal user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); users.reload(); }} />}
    </div>
  );
}

function UserModal({ user, onClose, onSaved }) {
  const isNew = !user.id;
  const [form, setForm] = useState({ name: user.name || '', username: user.username || '', role: user.role || 'staff', active: user.active !== 0, password: '' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const save = async (e) => {
    e?.preventDefault();
    try {
      if (isNew) await post('/users', form);
      else await put(`/users/${user.id}`, form);
      toast('Saved');
      onSaved();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={isNew ? 'Add staff' : `Edit ${user.name}`} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button class="primary" onClick={save}>Save</button></>}>
      <form class="stack" onSubmit={save}>
        <ErrorBox error={error} />
        <label class="field"><span>Name</span><input autoFocus value={form.name} onInput={set('name')} /></label>
        {isNew && <label class="field"><span>Username</span><input value={form.username} onInput={set('username')} autocomplete="off" /></label>}
        <label class="field"><span>{isNew ? 'Password' : 'New password (leave blank to keep)'}</span><input type="password" value={form.password} onInput={set('password')} autocomplete="new-password" /></label>
        <label class="field"><span>Role</span><select value={form.role} onChange={set('role')}><option value="staff">Cashier</option><option value="admin">Admin</option></select></label>
        {!isNew && <label class="row"><input type="checkbox" checked={form.active} onChange={set('active')} /> Account active</label>}
        <button hidden />
      </form>
    </Modal>
  );
}
