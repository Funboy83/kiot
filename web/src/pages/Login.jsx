import { useState } from 'preact/hooks';
import { post } from '../api.js';

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await post('/auth/login', form));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login">
      <form class="card stack" onSubmit={submit}>
        <h1>Sign in</h1>
        {error && <div class="error">{error}</div>}
        <label class="field">
          <span>Username</span>
          <input autoFocus autocomplete="username" value={form.username} onInput={(e) => setForm({ ...form, username: e.currentTarget.value })} />
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" autocomplete="current-password" value={form.password} onInput={(e) => setForm({ ...form, password: e.currentTarget.value })} />
        </label>
        <button class="primary" style="width:100%" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
