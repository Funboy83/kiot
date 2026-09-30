import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { LocationProvider, Router, Route, lazy, ErrorBoundary, useLocation } from 'preact-iso';
import { get, post, setUnauthorizedHandler, configureFormats, money } from './api.js';
import { AppContext, Toasts, SearchSelect, Status, useApp } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import './styles.css';

// Each screen is its own chunk, so the first load only ships what it shows.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Pos = lazy(() => import('./pages/Pos.jsx'));
const Products = lazy(() => import('./pages/Products.jsx'));
const ProductDetail = lazy(() => import('./pages/ProductDetail.jsx'));
const ProductForm = lazy(() => import('./pages/ProductForm.jsx'));
const Receipts = lazy(() => import('./pages/Receipts.jsx'));
const ReceiptForm = lazy(() => import('./pages/ReceiptForm.jsx'));
const ReceiptDetail = lazy(() => import('./pages/ReceiptDetail.jsx'));
const StockTakes = lazy(() => import('./pages/StockTakes.jsx'));
const StockTakeForm = lazy(() => import('./pages/StockTakeForm.jsx'));
const Invoices = lazy(() => import('./pages/Invoices.jsx'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail.jsx'));
const Customers = lazy(() => import('./pages/Customers.jsx'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));

const NAV = [
  ['/', 'Dashboard'],
  ['/products', 'Products'],
  ['/inventory', 'Inventory'],
  ['/invoices', 'Invoices'],
  ['/orders', 'Orders'],
  ['/customers', 'Customers'],
  ['/reports', 'Reports'],
];

function isActive(path, href) {
  if (href === '/') return path === '/';
  if (href === '/inventory') return path.startsWith('/inventory') || path.startsWith('/stocktakes');
  return path === href || path.startsWith(href + '/');
}

function GlobalSearch() {
  const { route } = useLocation();
  const load = async (q, signal) => {
    const r = await get('/search?q=' + encodeURIComponent(q), signal);
    return [
      ...r.serials.map((s) => ({ kind: 'Serial/IMEI', href: s.invoice_id ? `/invoices/${s.invoice_id}` : `/products/${s.product_id}?tab=serials`, title: s.serial, sub: s.name, extra: <Status value={s.status} /> })),
      ...r.invoices.map((i) => ({ kind: i.kind === 'order' ? 'Order' : 'Invoice', href: `/invoices/${i.id}`, title: i.code, sub: money(i.total), extra: <Status value={i.status} /> })),
      ...r.products.map((p) => ({ kind: 'Product', href: `/products/${p.id}`, title: p.name, sub: p.sku, extra: <span class="num">{money(p.price)}</span> })),
      ...r.customers.map((c) => ({ kind: 'Customer', href: `/customers/${c.id}`, title: c.name, sub: c.phone || c.code, extra: c.debt ? <span class="badge warn">owes {money(c.debt)}</span> : null })),
    ];
  };
  return (
    <div class="gsearch">
      <SearchSelect
        placeholder="Search products, customers, invoices, IMEI…  ( / )"
        inputRef={globalSearchRef}
        load={load}
        onPick={(it) => route(it.href)}
        render={(it) => (
          <>
            <span class="badge">{it.kind}</span>
            <span class="grow">{it.title} <span class="faint small">{it.sub}</span></span>
            {it.extra}
          </>
        )}
      />
    </div>
  );
}
const globalSearchRef = { current: null };

function Shell({ user, onLogout, children }) {
  const { path } = useLocation();
  const { settings } = useApp();
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName)) {
        e.preventDefault();
        globalSearchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (path === '/pos') return children;
  return (
    <>
      <header class="topbar">
        <a class="brand" href="/">{settings.store_name || 'Store'}</a>
        <nav class="nav" aria-label="Main">
          {NAV.map(([href, label]) => (
            <a key={href} href={href} class={isActive(path, href) ? 'active' : ''}>{label}</a>
          ))}
        </nav>
        <span class="spacer hide-md" />
        <GlobalSearch />
        <a class="btn pos-btn" href="/pos">🛒 Sell</a>
        <details class="user-menu" style="position:relative" onClick={(e) => e.target.closest('a') && e.currentTarget.removeAttribute('open')}>
          <summary class="btn user-btn" style="list-style:none">{user.name}</summary>
          <div class="dropdown" style="left:auto;right:0;min-width:160px">
            {user.role === 'admin' && <a class="opt" href="/settings">Settings & staff</a>}
            <a class="opt" href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>Sign out</a>
          </div>
        </details>
      </header>
      <main class="page">{children}</main>
    </>
  );
}

function NotFound() {
  return <div class="empty">Page not found. <a href="/">Go to dashboard</a></div>;
}

function App() {
  const [user, setUser] = useState(undefined);
  const [settings, setSettings] = useState({});

  const loadSettings = () =>
    get('/settings').then((s) => {
      configureFormats(s);
      setSettings(s);
      document.title = s.store_name;
    });

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    get('/auth/me')
      .then(async (u) => {
        await loadSettings();
        setUser(u);
      })
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (!user) return <Login onLogin={async (u) => { await loadSettings(); setUser(u); }} />;

  const logout = async () => {
    await post('/auth/logout').catch(() => {});
    setUser(null);
  };

  return (
    <AppContext.Provider value={{ user, settings, reloadSettings: loadSettings }}>
      <LocationProvider>
        <ErrorBoundary>
          <Shell user={user} onLogout={logout}>
            <Router>
              <Route path="/" component={Dashboard} />
              <Route path="/pos" component={Pos} />
              <Route path="/products" component={Products} />
              <Route path="/products/new" component={ProductForm} />
              <Route path="/products/:id/edit" component={ProductForm} />
              <Route path="/products/:id" component={ProductDetail} />
              <Route path="/inventory" component={Receipts} />
              <Route path="/inventory/receipts/new" component={ReceiptForm} />
              <Route path="/inventory/receipts/:id" component={ReceiptDetail} />
              <Route path="/stocktakes" component={StockTakes} />
              <Route path="/stocktakes/new" component={StockTakeForm} />
              <Route path="/stocktakes/:id" component={StockTakeForm} />
              <Route path="/invoices" component={Invoices} />
              <Route path="/orders" component={Invoices} kind="order" />
              <Route path="/invoices/:id" component={InvoiceDetail} />
              <Route path="/customers" component={Customers} />
              <Route path="/customers/:id" component={CustomerDetail} />
              <Route path="/reports" component={Reports} />
              <Route path="/settings" component={Settings} />
              <Route default component={NotFound} />
            </Router>
          </Shell>
        </ErrorBoundary>
      </LocationProvider>
      <Toasts />
    </AppContext.Provider>
  );
}

render(<App />, document.getElementById('app'));
