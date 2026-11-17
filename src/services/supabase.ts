import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { PackageItem, PackageStatus, UserProfile } from '../types';

// Real Supabase project host
export const REAL_SUPABASE_URL = 'https://vplhnaqjdpicfsogjihk.supabase.co';

export function sanitizeSupabaseUrl(input?: string): string {
  if (!input || typeof input !== 'string') return REAL_SUPABASE_URL;
  const trimmed = input.trim();
  if (trimmed.startsWith('sb_') || trimmed.startsWith('eyJ')) {
    return REAL_SUPABASE_URL;
  }
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  if (match) {
    let urlStr = match[0].replace(/[.,;:)\]]+$/, '');
    urlStr = urlStr.replace('yplhnagidpicfsogjihk', 'vplhnaqjdpicfsogjihk');
    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // Fallback below
    }
  }
  return REAL_SUPABASE_URL;
}

const rawViteUrl = ((import.meta.env.VITE_SUPABASE_URL as string) || '').trim();
const DEFAULT_SUPABASE_URL = sanitizeSupabaseUrl(rawViteUrl);

// Support anon key: handle if publishable key was placed in VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY
const rawViteKey = ((import.meta.env.VITE_SUPABASE_ANON_KEY as string) || '').trim();
const viteUrlIsKey = rawViteUrl.startsWith('sb_publishable_') || rawViteUrl.startsWith('eyJ');
export const DEFAULT_SUPABASE_ANON_KEY = rawViteKey || (viteUrlIsKey ? rawViteUrl : '');

// Client-side Supabase client initialized with anonymous/publishable key only
export const supabaseClient: SupabaseClient = createClient(
  DEFAULT_SUPABASE_URL,
  DEFAULT_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

export const AUTH_SESSION_STORAGE_KEY = 'fariousy_auth_session';
export const REMEMBER_ME_STORAGE_KEY = 'fariousy_remember_me';

export function getRememberMePreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    if (sessionStorage.getItem(REMEMBER_ME_STORAGE_KEY) === '0') return false;
    if (localStorage.getItem(REMEMBER_ME_STORAGE_KEY) === '0') return false;
    return true;
  } catch {
    return true;
  }
}

export function getStoredAuthSession(): { token?: string; user?: any } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw =
      sessionStorage.getItem(AUTH_SESSION_STORAGE_KEY) ||
      localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveStoredAuthSession(
  payload: { token?: string; user: any },
  rememberMe?: boolean
): void {
  if (typeof window === 'undefined') return;
  const persist = rememberMe !== undefined ? rememberMe : getRememberMePreference();
  const serialized = JSON.stringify(payload);
  try {
    if (persist) {
      localStorage.setItem(AUTH_SESSION_STORAGE_KEY, serialized);
      localStorage.setItem(REMEMBER_ME_STORAGE_KEY, '1');
      sessionStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
      sessionStorage.removeItem(REMEMBER_ME_STORAGE_KEY);
    } else {
      sessionStorage.setItem(AUTH_SESSION_STORAGE_KEY, serialized);
      sessionStorage.setItem(REMEMBER_ME_STORAGE_KEY, '0');
      localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
      localStorage.removeItem(REMEMBER_ME_STORAGE_KEY);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function clearStoredAuthSession(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    localStorage.removeItem(REMEMBER_ME_STORAGE_KEY);
    sessionStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    sessionStorage.removeItem(REMEMBER_ME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  let token: string | null = null;

  let localSessionUser: any = null;
  let localToken: string | null = null;
  let impersonatorAdmin: any = null;
  let impersonatorToken: string | null = null;
  if (typeof window !== 'undefined') {
    try {
      const parsed = getStoredAuthSession();
      if (parsed?.token) localToken = parsed.token;
      if (parsed?.user) localSessionUser = parsed.user;
      const rawImp = sessionStorage.getItem('fariousy_impersonator_admin') || localStorage.getItem('fariousy_impersonator_admin');
      if (rawImp) impersonatorAdmin = JSON.parse(rawImp);
      impersonatorToken = sessionStorage.getItem('fariousy_impersonator_token') || localStorage.getItem('fariousy_impersonator_token');
    } catch {}
  }

  const tokenMatchesUser = (tok: string | null, usr: any) =>
    Boolean(tok && usr?.id && tok.startsWith(`far_sec_${usr.id}_`));

  const isValidLocalServerToken =
    localToken &&
    localToken.startsWith('far_sec_') &&
    (!localSessionUser?.id ||
      tokenMatchesUser(localToken, localSessionUser) ||
      tokenMatchesUser(localToken, impersonatorAdmin));

  // If the current active login session uses a matching FARIOUSY server token (e.g. local/server auth or impersonation),
  // prefer it so an older Supabase session for a different role/user never overrides the active session.
  if (isValidLocalServerToken) {
    headers['Authorization'] = `Bearer ${localToken}`;
    return headers;
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session?.access_token) {
      const sbEmail = session.user?.email?.toLowerCase();
      const localEmail = localSessionUser?.email?.toLowerCase();
      const impEmail = impersonatorAdmin?.email?.toLowerCase();
      const matchesLocalUser = !localEmail || !sbEmail || sbEmail === localEmail || (Boolean(impEmail) && sbEmail === impEmail);

      if (matchesLocalUser) {
        const isExpiringSoon = session.expires_at ? session.expires_at * 1000 < Date.now() + 15000 : false;
        if (isExpiringSoon) {
          const { data: refreshed } = await supabaseClient.auth.refreshSession();
          if (refreshed?.session?.access_token) {
            token = refreshed.session.access_token;
          }
        } else {
          token = session.access_token;
        }
      }
    }
  } catch {}

  if (!token && (impersonatorToken || (isValidLocalServerToken ? localToken : null) || localToken)) {
    token = impersonatorToken || (isValidLocalServerToken ? localToken : null) || localToken;
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch profile from public.profiles table using Supabase Auth user ID.
 * Merges shop account_status and status_reason for merchant clients.
 */
export async function fetchUserProfileFromDb(userId: string, accessToken?: string): Promise<any | null> {
  if (!userId) return null;

  // 1. Server endpoint with Bearer token (preferred: secure join of public.profiles + public.merchant_shops)
  if (accessToken) {
    try {
      const resp = await fetch('/api/auth/profile', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json.success && json.profile) {
          return json.profile;
        }
      }
    } catch (e) {
      console.warn('[Server profile endpoint notice, trying direct client query]', e);
    }
  }

  // 2. Direct query with Supabase client (fallback)
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (!error && data) {
      if (data.role === 'client') {
        const { data: shop } = await supabaseClient
          .from('merchant_shops')
          .select('account_status, status_reason, approved_at, approved_by, shop_name')
          .eq('user_id', userId)
          .maybeSingle();

        if (shop) {
          return {
            ...data,
            company_name: shop.shop_name,
            status: shop.account_status,
            account_status: shop.account_status,
            status_reason: shop.status_reason,
            approved_at: shop.approved_at,
            approved_by: shop.approved_by
          };
        }
      }
      return data;
    }
  } catch (err) {
    console.warn('[Direct profile select failed]', err);
  }

  return null;
}

/**
 * Loads real clients and their merchant shops from public.profiles and public.merchant_shops.
 * Enforces admin authorization via Supabase Auth session.
 * Does NOT use secret keys in frontend.
 */
export async function fetchSupabaseClients(): Promise<{
  clients: UserProfile[];
  error: string | null;
}> {
  try {
    const headers = await getAuthHeaders();

    // 1. Call server endpoint (enforces RLS and role=admin on server)
    try {
      let resp = await fetch('/api/admin/clients', { headers });
      if (resp.status === 401) {
        // Try refreshing Supabase session or retrying with alternate stored token once
        try {
          const { data: refreshed } = await supabaseClient.auth.refreshSession();
          if (refreshed?.session?.access_token) {
            resp = await fetch('/api/admin/clients', {
              headers: { Authorization: `Bearer ${refreshed.session.access_token}` }
            });
          }
        } catch {}
      }

      if (resp.ok) {
        const json = await resp.json();
        if (json.success && Array.isArray(json.clients)) {
          return { clients: json.clients, error: null };
        }
        if (json.error) {
          return { clients: [], error: json.error };
        }
      } else if (resp.status === 401 || resp.status === 403) {
        const errJson = await resp.json().catch(() => ({}));
        return { clients: [], error: errJson.error || `Accès refusé (${resp.status}) : rôle Administrateur requis dans Supabase.` };
      }
    } catch (apiErr: any) {
      console.warn('[API Clients Fetch Notice, trying direct query]', apiErr);
    }

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
      return { clients: [], error: 'Utilisateur non authentifié sur Supabase.' };
    }

    // Direct browser query fallback with current authenticated session
    const [shopsRes, profsRes] = await Promise.all([
      supabaseClient
        .from('merchant_shops')
        .select('*, profiles:user_id(id, full_name, email, phone, whatsapp, city, address, role)')
        .order('created_at', { ascending: false }),
      supabaseClient
        .from('profiles')
        .select('*')
        .eq('role', 'client')
        .order('created_at', { ascending: false })
    ]);

    if (shopsRes.error) {
      return { clients: [], error: `Erreur Supabase merchant_shops: ${shopsRes.error.message}` };
    }
    if (profsRes.error) {
      return { clients: [], error: `Erreur Supabase profiles: ${profsRes.error.message}` };
    }

    const shopsData = shopsRes.data || [];
    const profilesData = profsRes.data || [];
    const shopUserIds = new Set(shopsData.map(s => s.user_id));
    const mergedClients: UserProfile[] = [];

    for (const shop of shopsData) {
      mergedClients.push({
        id: shop.user_id || shop.id,
        name: (shop.manager_name || shop.profiles?.full_name || shop.shop_name || 'Gérant').trim(),
        companyName: (shop.shop_name || '').trim() || shop.manager_name || shop.profiles?.full_name || 'Boutique',
        email: shop.email || shop.profiles?.email || '',
        phone: shop.phone || shop.profiles?.phone || '',
        whatsapp: shop.whatsapp || shop.profiles?.whatsapp || undefined,
        city: shop.city || shop.profiles?.city || 'Casablanca',
        address: shop.pickup_address || shop.profiles?.address || '',
        activityType: shop.activity_type || 'Commerce général',
        bankName: shop.bank_name || shop.profiles?.bank_name || undefined,
        bankRib: shop.bank_rib || shop.profiles?.bank_rib || undefined,
        role: 'client',
        status: (shop.account_status as any) || 'en_attente',
        accountStatus: (shop.account_status as any) || 'en_attente',
        statusReason: shop.status_reason || undefined,
        approvedAt: shop.approved_at || undefined,
        approvedBy: shop.approved_by || undefined,
        registeredAt: shop.created_at || new Date().toISOString()
      });
    }

    for (const prof of profilesData) {
      if (!shopUserIds.has(prof.id)) {
        mergedClients.push({
          id: prof.id,
          name: prof.full_name || 'Client',
          companyName: prof.full_name || 'Client Individuel',
          email: prof.email || '',
          phone: prof.phone || '',
          whatsapp: prof.whatsapp || undefined,
          city: prof.city || 'Casablanca',
          address: prof.address || '',
          activityType: 'Commerce général',
          bankName: prof.bank_name || undefined,
          bankRib: prof.bank_rib || undefined,
          role: 'client',
          status: 'active',
          accountStatus: 'approuve',
          registeredAt: prof.created_at || new Date().toISOString()
        });
      }
    }

    return { clients: mergedClients, error: null };
  } catch (err: any) {
    return { clients: [], error: err.message || 'Erreur inattendue de connexion Supabase.' };
  }
}

/**
 * Loads real packages directly from Supabase Production (public.packages & public.merchant_shops).
 * Enforces admin authorization via Supabase Auth session.
 * Excludes all mock data (INITIAL_PACKAGES).
 */
export async function fetchSupabasePackages(): Promise<{
  packages: PackageItem[];
  error: string | null;
}> {
  try {
    const headers = await getAuthHeaders();
    const storedSess = getStoredAuthSession();
    const storedRole = String(storedSess?.user?.role || '').toLowerCase();
    const isImpersonating =
      typeof window !== 'undefined' &&
      Boolean(
        sessionStorage.getItem('fariousy_impersonator_admin') ||
          localStorage.getItem('fariousy_impersonator_admin')
      );
    const isClientSession =
      !isImpersonating &&
      (storedRole === 'client' || storedRole === 'boutique' || storedRole === 'merchant' || storedRole === 'vendeur');

    // 1. Call role-appropriate server endpoint (enforces admin/client isolation and server-side join)
    try {
      if (isClientSession) {
        const clientResp = await fetch('/api/client/packages', { headers, credentials: 'include' });
        if (clientResp.ok) {
          const clientJson = await clientResp.json();
          if (clientJson.success && Array.isArray(clientJson.packages)) {
            return { packages: clientJson.packages, error: null };
          }
          if (clientJson.error) {
            return { packages: [], error: clientJson.error };
          }
        } else if (clientResp.status === 403) {
          const errJson = await clientResp.json().catch(() => ({}));
          return { packages: [], error: errJson.error || "Accès non autorisé ou compte client suspendu." };
        }
      } else {
        const resp = await fetch('/api/admin/packages', { headers, credentials: 'include' });
        if (resp.ok) {
          const json = await resp.json();
          if (json.success && Array.isArray(json.packages)) {
            return { packages: json.packages, error: null };
          }
          if (json.error) {
            return { packages: [], error: json.error };
          }
        } else if (resp.status === 403 || resp.status === 401) {
          // Utilisateur avec rôle 'client' : basculer automatiquement sur l'endpoint sécurisé client
          const clientResp = await fetch('/api/client/packages', { headers, credentials: 'include' });
          if (clientResp.ok) {
            const clientJson = await clientResp.json();
            if (clientJson.success && Array.isArray(clientJson.packages)) {
              return { packages: clientJson.packages, error: null };
            }
          }
          if (clientResp.status === 403) {
            const errJson = await clientResp.json().catch(() => ({}));
            return { packages: [], error: errJson.error || "Accès non autorisé ou compte client suspendu." };
          }
        }
      }
    } catch (apiErr: any) {
      console.warn('[API Packages Fetch Notice, trying direct query]', apiErr);
    }

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
      return { packages: [], error: 'Utilisateur non authentifié sur Supabase.' };
    }

    // 2. Direct browser query fallback with current authenticated session (RLS)
    const { data: rows, error: pkgErr } = await supabaseClient
      .from('packages')
      .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city)')
      .order('created_at', { ascending: false });

    if (pkgErr) {
      return { packages: [], error: `Erreur Supabase packages: ${pkgErr.message}` };
    }

    const mapped: PackageItem[] = (rows || []).map((row: any) => {
      const cod = Number(row.cod_amount || 0);
      const fee = Number(row.delivery_fee || 0);
      const price = Math.max(0, Math.round((cod - fee) * 100) / 100);

      return {
        id: row.id,
        trackingNumber: row.tracking_number,
        clientId: row.merchant_shops?.user_id || row.shop_id,
        clientName: row.merchant_shops?.manager_name || 'Gérant',
        clientCompany: row.merchant_shops?.shop_name || 'Boutique',
        clientPhone: row.merchant_shops?.phone || '',
        recipientName: row.recipient_name,
        recipientPhone: row.recipient_phone,
        city: row.destination_city || 'Casablanca',
        address: row.destination_address || '',
        description: row.item_description || '',
        codAmount: cod,
        deliveryFee: fee,
        productPrice: price,
        status: row.status || 'attente_ramassage',
        currentAgency: row.current_agency || 'Agence Principale',
        isPaidToClient: row.is_paid_to_client ?? false,
        allowOpen: typeof row.allow_open === 'boolean' ? row.allow_open : undefined,
        allowTry: typeof row.allow_try === 'boolean' ? row.allow_try : undefined,
        isFragile: typeof row.is_fragile === 'boolean' ? row.is_fragile : false,
        isExchange: typeof row.is_exchange === 'boolean' ? row.is_exchange : false,
        createdAt: row.created_at || new Date().toISOString(),
        lastMovedAt: row.updated_at || row.created_at || new Date().toISOString(),
        history: []
      };
    });

    return { packages: mapped, error: null };
  } catch (err: any) {
    return { packages: [], error: err.message || 'Erreur inattendue de connexion Supabase pour les colis.' };
  }
}

/**
 * Loads real packages for the authenticated client from Supabase Production (public.packages).
 * Enforces client authorization and shop isolation via Supabase Auth session token.
 */
export async function fetchClientPackages(): Promise<{
  packages: PackageItem[];
  error: string | null;
}> {
  try {
    const headers = await getAuthHeaders();

    try {
      const resp = await fetch('/api/client/packages', { headers, credentials: 'include' });
      if (resp.ok) {
        const json = await resp.json();
        if (json.success && Array.isArray(json.packages)) {
          return { packages: json.packages, error: null };
        }
        if (json.error) {
          return { packages: [], error: json.error };
        }
      } else if (resp.status === 403) {
        const errJson = await resp.json().catch(() => ({}));
        return { packages: [], error: errJson.error || "Compte client suspendu ou accès non autorisé." };
      }
    } catch (apiErr: any) {
      console.warn('[API Client Packages Fetch Notice, fallback direct query]', apiErr);
    }

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
      return { packages: [], error: 'Utilisateur non authentifié sur Supabase.' };
    }

    // Direct browser query with RLS enforcement
    const { data: rows, error: pkgErr } = await supabaseClient
      .from('packages')
      .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city)')
      .order('created_at', { ascending: false });

    if (pkgErr) {
      return { packages: [], error: `Erreur Supabase packages: ${pkgErr.message}` };
    }

    const mapped: PackageItem[] = (rows || []).map((row: any) => {
      const cod = Number(row.cod_amount || 0);
      const fee = Number(row.delivery_fee || 0);
      const price = Math.max(0, Math.round((cod - fee) * 100) / 100);

      return {
        id: row.id,
        trackingNumber: row.tracking_number,
        shopId: row.shop_id,
        clientId: row.merchant_shops?.user_id || row.shop_id,
        clientName: row.merchant_shops?.manager_name || 'Gérant',
        clientCompany: row.merchant_shops?.shop_name || 'Boutique',
        clientPhone: row.merchant_shops?.phone || '',
        recipientName: row.recipient_name,
        recipientPhone: row.recipient_phone,
        city: row.destination_city || 'Casablanca',
        address: row.destination_address || '',
        description: row.item_description || '',
        codAmount: cod,
        deliveryFee: fee,
        productPrice: price,
        status: row.status || 'attente_ramassage',
        currentAgency: row.current_agency || 'Agence Principale',
        isPaidToClient: row.is_paid_to_client ?? false,
        allowOpen: typeof row.allow_open === 'boolean' ? row.allow_open : undefined,
        allowTry: typeof row.allow_try === 'boolean' ? row.allow_try : undefined,
        isFragile: typeof row.is_fragile === 'boolean' ? row.is_fragile : false,
        isExchange: typeof row.is_exchange === 'boolean' ? row.is_exchange : false,
        createdAt: row.created_at || new Date().toISOString(),
        lastMovedAt: row.updated_at || row.created_at || new Date().toISOString(),
        history: []
      };
    });

    return { packages: mapped, error: null };
  } catch (err: any) {
    return { packages: [], error: err.message || 'Erreur inattendue de connexion Supabase pour les colis client.' };
  }
}

export interface CreatePackagePayload {
  shopId: string;
  clientName?: string;
  clientCompany?: string;
  clientPhone?: string;
  recipientName: string;
  recipientPhone: string;
  city: string;
  address: string;
  description?: string;
  productPrice: number;
  deliveryFee: number;
  codAmount: number;
  notes?: string;
  allowOpen?: boolean;
  allowTry?: boolean;
  isFragile?: boolean;
  isExchange?: boolean;
  exchangeTrackingNumber?: string;
  exchangeReason?: string;
  exchangeItemDescription?: string;
  stockLocationId?: string;
  stockPosition?: string;
}

/**
 * Creates a real package in Supabase Production (public.packages).
 * Uses secure server-side endpoint with admin/client session token.
 */
export async function createSupabasePackage(payload: CreatePackagePayload): Promise<{
  success: boolean;
  message?: string;
  package?: PackageItem;
  error?: string;
}> {
  const tryPost = async (endpoint: string, token?: string) => {
    const hdrs: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) hdrs['Authorization'] = `Bearer ${token}`;
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(payload)
    });
    const rawText = await r.text();
    let json: any = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      json = {};
    }
    return { resp: r, rawText, json };
  };

  try {
    const candidateTokens: string[] = [];
    const addCandidate = (t?: string | null) => {
      if (t && typeof t === 'string' && t.trim() && !candidateTokens.includes(t.trim())) {
        candidateTokens.push(t.trim());
      }
    };

    const authHeaders = await getAuthHeaders();
    if (authHeaders['Authorization']?.startsWith('Bearer ')) {
      addCandidate(authHeaders['Authorization'].slice(7));
    }

    if (typeof window !== 'undefined') {
      try {
        const impTok =
          sessionStorage.getItem('fariousy_impersonator_token') ||
          localStorage.getItem('fariousy_impersonator_token');
        addCandidate(impTok);
        const parsed = getStoredAuthSession();
        addCandidate(parsed?.token);
      } catch {}
    }

    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      addCandidate(session?.access_token);
    } catch {}

    let lastResult = await tryPost('/api/packages', candidateTokens[0]);

    if (lastResult.resp.ok && lastResult.json.success) {
      return {
        success: true,
        message: lastResult.json.message,
        package: lastResult.json.package
      };
    }

    // Try refreshed Supabase token + remaining candidate tokens across /api/packages and /api/admin/packages
    if (lastResult.resp.status === 401 || lastResult.resp.status === 403 || lastResult.resp.status === 404) {
      try {
        const { data: refreshed } = await supabaseClient.auth.refreshSession();
        addCandidate(refreshed?.session?.access_token);
      } catch {}

      const endpoints = ['/api/packages', '/api/admin/packages'];
      for (const ep of endpoints) {
        for (const tok of candidateTokens) {
          if (ep === '/api/packages' && tok === candidateTokens[0]) continue;
          const attempt = await tryPost(ep, tok);
          if (attempt.resp.ok && attempt.json.success) {
            return {
              success: true,
              message: attempt.json.message,
              package: attempt.json.package
            };
          }
          if (attempt.json.error || attempt.json.message || (!lastResult.json.error && !lastResult.json.message)) {
            lastResult = attempt;
          }
          if (attempt.json.code === 'ACCOUNT_SUSPENDED') {
            break;
          }
        }
      }
    }

    // Fallback: if upstream proxy/WAF still returned HTML 403, try direct authenticated Supabase insert if session exists
    if (lastResult.resp.status === 403 && !lastResult.json.error && !lastResult.json.message) {
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session?.user) {
          const trackingNumber = `FAR-${Math.floor(100000 + Math.random() * 900000)}`;
          const now = new Date().toISOString();
          const fullDesc = payload.notes?.trim()
            ? `${(payload.description || 'Colis e-commerce').trim()} [Remarques: ${payload.notes.trim()}]`
            : (payload.description || 'Colis e-commerce').trim();

          const { data: shopRow } = await supabaseClient
            .from('merchant_shops')
            .select('id, user_id, shop_name, manager_name, phone')
            .or(`id.eq.${payload.shopId},user_id.eq.${payload.shopId}`)
            .maybeSingle();

          const { data: inserted, error: insertErr } = await supabaseClient
            .from('packages')
            .insert({
              shop_id: shopRow?.id || payload.shopId,
              tracking_number: trackingNumber,
              recipient_name: payload.recipientName.trim(),
              recipient_phone: payload.recipientPhone.trim(),
              destination_city: payload.city.trim(),
              destination_address: payload.address.trim(),
              item_description: fullDesc,
              cod_amount: payload.codAmount,
              delivery_fee: payload.deliveryFee,
              status: 'attente_ramassage',
              is_paid_to_client: false,
              created_at: now,
              updated_at: now
            })
            .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city)')
            .single();

          if (!insertErr && inserted) {
            return {
              success: true,
              message: `Colis ${inserted.tracking_number} enregistré avec succès.`,
              package: {
                id: inserted.id,
                trackingNumber: inserted.tracking_number,
                shopId: inserted.shop_id,
                clientId: inserted.merchant_shops?.user_id || inserted.shop_id,
                clientName: inserted.merchant_shops?.manager_name || payload.clientName || 'Gérant',
                clientCompany: inserted.merchant_shops?.shop_name || payload.clientCompany || 'Boutique',
                clientPhone: inserted.merchant_shops?.phone || payload.clientPhone || '',
                recipientName: inserted.recipient_name,
                recipientPhone: inserted.recipient_phone,
                city: inserted.destination_city,
                address: inserted.destination_address,
                description: inserted.item_description,
                codAmount: Number(inserted.cod_amount || payload.codAmount),
                deliveryFee: Number(inserted.delivery_fee || payload.deliveryFee),
                productPrice: payload.productPrice,
                status: inserted.status || 'attente_ramassage',
                currentAgency: 'Agence Principale',
                isPaidToClient: false,
                createdAt: inserted.created_at || now,
                lastMovedAt: inserted.updated_at || now,
                history: []
              }
            };
          }
        }
      } catch {}
    }

    const cleanRaw = lastResult.rawText
      ? lastResult.rawText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
      : '';
    return {
      success: false,
      error:
        lastResult.json.error ||
        lastResult.json.message ||
        (cleanRaw
          ? `Erreur serveur HTTP ${lastResult.resp.status} (${cleanRaw})`
          : `Erreur serveur HTTP ${lastResult.resp.status} lors de l'enregistrement du colis.`)
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la création du colis.'
    };
  }
}

/**
 * Updates a package status in Supabase Production (public.packages).
 * Uses secure server-side endpoint with admin/employee Bearer session token.
 */
export async function updatePackageStatusInSupabase(
  packageId: string,
  newStatus: PackageStatus,
  comment?: string,
  extra?: { problemReport?: any; callProofUrl?: string }
): Promise<{
  success: boolean;
  message?: string;
  package?: PackageItem;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders
    };

    const resp = await fetch(`/api/admin/packages/${encodeURIComponent(packageId)}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        status: newStatus,
        comment,
        problemReport: extra?.problemReport,
        callProofUrl: extra?.callProofUrl
      })
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status} lors de la mise à jour du statut.`
      };
    }

    return {
      success: true,
      message: json.message,
      package: json.package
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la mise à jour du statut du colis.'
    };
  }
}

/**
 * Loads real drivers directly from Supabase Production (public.profiles WHERE role = 'driver').
 * Enforces admin/employee authorization via Supabase Auth session.
 * Excludes all mock data (INITIAL_DRIVERS).
 */
export async function fetchSupabaseDrivers(): Promise<{
  drivers: UserProfile[];
  error: string | null;
}> {
  try {
    const headers = await getAuthHeaders();

    const resp = await fetch('/api/admin/drivers', { headers });
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      return {
        drivers: [],
        error: errJson.error || `Erreur serveur HTTP ${resp.status} lors de la lecture des livreurs.`
      };
    }

    const json = await resp.json();
    return {
      drivers: Array.isArray(json.drivers) ? json.drivers : [],
      error: null
    };
  } catch (err: any) {
    return {
      drivers: [],
      error: err.message || 'Erreur inattendue de connexion Supabase pour les livreurs.'
    };
  }
}

export interface CreateDriverPayload {
  fullName: string;
  phone: string;
  email?: string;
  password: string;
  city?: string;
  vehicleType?: string;
  driverPlate?: string;
  cinNumber?: string;
  cinPhotoUrl?: string;
  cinBackPhotoUrl?: string;
  driverPhotoUrl?: string;
  avatarUrl?: string;
  feePerDelivery?: number;
  fixedSalary?: number;
  salaryType?: 'per_package' | 'fixed_plus_package' | 'monthly_fixed';
  pickupFee?: number;
  status?: 'active' | 'inactive';
}

export interface UpdateDriverPayload {
  name?: string;
  fullName?: string;
  phone?: string;
  email?: string;
  city?: string;
  driverVehicle?: string;
  driverPlate?: string;
  cinNumber?: string;
  cinPhotoUrl?: string;
  cinBackPhotoUrl?: string;
  driverPhotoUrl?: string;
  avatarUrl?: string;
  driverFeePerDelivery?: number;
  driverFixedSalary?: number;
  driverSalaryType?: 'per_package' | 'fixed_plus_package' | 'monthly_fixed';
  driverPickupFee?: number;
  driverBonusThreshold?: number;
  driverBonusAmount?: number;
  address?: string;
  whatsapp?: string;
  status?: UserProfile['status'];
}

export interface DriverCredentials {
  fullName: string;
  phone: string;
  email: string;
  password: string;
  city: string;
  vehicleType: string;
}

/**
 * Creates a real driver account in Supabase Auth and inserts their profile into public.profiles
 * with the strict role 'driver'.
 */
export async function createSupabaseDriver(payload: CreateDriverPayload): Promise<{
  success: boolean;
  driver?: UserProfile;
  credentials?: DriverCredentials;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': 'application/json'
    };

    const resp = await fetch('/api/admin/drivers', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status} lors de la création du livreur.`
      };
    }

    return {
      success: true,
      driver: json.driver,
      credentials: json.credentials
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la création du livreur dans Supabase.'
    };
  }
}

/**
 * Updates an existing driver profile and KYC/photo URLs in Supabase public.profiles + persistent storage.
 */
export async function updateSupabaseDriver(
  driverId: string,
  payload: UpdateDriverPayload
): Promise<{
  success: boolean;
  driver?: UserProfile;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': 'application/json'
    };

    const resp = await fetch(`/api/admin/drivers/${encodeURIComponent(driverId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status} lors de la mise à jour du livreur.`
      };
    }

    return {
      success: true,
      driver: json.driver
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la mise à jour du livreur dans Supabase.'
    };
  }
}

async function performAuthenticatedDelete(
  endpoints: string[]
): Promise<{ success: boolean; message?: string; error?: string }> {
  const candidateTokens: string[] = [];
  const addCandidate = (t?: string | null) => {
    if (t && typeof t === 'string' && t.trim() && !candidateTokens.includes(t.trim())) {
      candidateTokens.push(t.trim());
    }
  };

  try {
    const authHeaders = await getAuthHeaders();
    if (authHeaders['Authorization']?.startsWith('Bearer ')) {
      addCandidate(authHeaders['Authorization'].slice(7));
    }
  } catch {}

  if (typeof window !== 'undefined') {
    try {
      addCandidate(sessionStorage.getItem('fariousy_impersonator_token'));
      addCandidate(localStorage.getItem('fariousy_impersonator_token'));
      const parsed = getStoredAuthSession();
      addCandidate(parsed?.token);
    } catch {}
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    addCandidate(session?.access_token);
  } catch {}

  let lastStatus = 0;
  let lastError = '';

  const tryDelete = async (ep: string, token?: string) => {
    const hdrs: Record<string, string> = {};
    if (token) hdrs['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(ep, { method: 'DELETE', headers: hdrs });
    const rawText = await resp.text();
    let json: any = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      json = {};
    }
    return { resp, json, rawText };
  };

  const tokensToTry = candidateTokens.length > 0 ? candidateTokens : [undefined];
  for (const ep of endpoints) {
    for (const tok of tokensToTry) {
      try {
        const res = await tryDelete(ep, tok);
        if (res.resp.ok && res.json.success) {
          return {
            success: true,
            message: res.json.message || 'Supprimé définitivement de Supabase.'
          };
        }
        lastStatus = res.resp.status;
        lastError = res.json.error || res.json.message || `Erreur HTTP ${res.resp.status}`;
        if (res.resp.status !== 401 && res.resp.status !== 403 && res.resp.status !== 404) {
          return { success: false, error: lastError };
        }
      } catch (err: any) {
        lastError = err?.message || 'Erreur réseau';
      }
    }
  }

  return {
    success: false,
    error: lastError || `Échec de suppression dans Supabase (HTTP ${lastStatus || 500}).`
  };
}

/**
 * Permanently deletes a package from Supabase Production (public.packages).
 */
export async function deleteSupabasePackage(
  packageId: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  const encoded = encodeURIComponent(packageId);
  return performAuthenticatedDelete([
    `/api/admin/packages/${encoded}`,
    `/api/packages/${encoded}`
  ]);
}

/**
 * Permanently deletes a client (merchant_shops + profiles + packages + auth user) from Supabase.
 */
export async function deleteSupabaseClient(
  clientId: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  const encoded = encodeURIComponent(clientId);
  return performAuthenticatedDelete([`/api/admin/clients/${encoded}`]);
}

/**
 * Permanently deletes a driver from Supabase (profiles + auth user).
 */
export async function deleteSupabaseDriver(
  driverId: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  const encoded = encodeURIComponent(driverId);
  return performAuthenticatedDelete([`/api/admin/drivers/${encoded}`]);
}

/**
 * Resets/updates a driver's password in Supabase Auth via the Admin endpoint.
 */
export async function updateDriverPasswordInSupabase(
  driverId: string,
  newPassword: string
): Promise<{
  success: boolean;
  message?: string;
  driver?: { id: string; name: string; phone: string; email: string };
  newPassword?: string;
  error?: string;
}> {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const resp = await fetch(`/api/admin/drivers/${encodeURIComponent(driverId)}/password`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ newPassword })
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur HTTP ${resp.status} lors de la mise à jour du mot de passe.`
      };
    }

    return {
      success: true,
      message: json.message,
      driver: json.driver,
      newPassword: json.newPassword
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la mise à jour du mot de passe.'
    };
  }
}

/**
 * Resets/updates a client's password in Supabase Auth via the Admin endpoint.
 */
export async function updateClientPasswordInSupabase(
  clientId: string,
  newPassword: string
): Promise<{
  success: boolean;
  message?: string;
  client?: { id: string; name: string; phone: string; email: string };
  newPassword?: string;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders
    };

    const resp = await fetch(`/api/admin/clients/${encodeURIComponent(clientId)}/password`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ newPassword })
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur HTTP ${resp.status} lors de la mise à jour du mot de passe.`
      };
    }

    return {
      success: true,
      message: json.message,
      client: json.client,
      newPassword: json.newPassword
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la mise à jour du mot de passe.'
    };
  }
}

/**
 * Resolves a login identifier (phone number or email) to its associated Supabase Auth email.
 */
export async function resolveLoginIdentifier(identifier: string): Promise<{
  success: boolean;
  email?: string;
  role?: string;
  name?: string;
  phone?: string;
  error?: string;
}> {
  try {
    const resp = await fetch('/api/auth/resolve-identifier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier })
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || 'Identifiant introuvable.'
      };
    }

    return {
      success: true,
      email: json.email,
      role: json.role,
      name: json.name,
      phone: json.phone
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la résolution de l\'identifiant.'
    };
  }
}

/**
 * Assigns or reassigns one or multiple packages to a driver in Supabase Production (public.packages.driver_id).
 */
export async function assignPackagesToDriverInSupabase(
  packageIds: string[],
  driverId: string | null,
  updateStatus: boolean = false
): Promise<{
  success: boolean;
  message?: string;
  driverName?: string;
  updatedCount?: number;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders
    };

    const resp = await fetch('/api/admin/packages/assign-driver', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ packageIds, driverId, updateStatus })
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur HTTP ${resp.status} lors de l'affectation.`
      };
    }

    return {
      success: true,
      message: json.message,
      driverName: json.driverName,
      updatedCount: json.updatedCount
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Erreur réseau lors de l'affectation du colis au livreur."
    };
  }
}

/**
 * Loads packages assigned strictly to the authenticated driver from Supabase Production.
 */
export async function fetchDriverAssignedPackages(driverId?: string): Promise<{
  packages: PackageItem[];
  error: string | null;
}> {
  try {
    const headers = await getAuthHeaders();

    const url = driverId ? `/api/driver/packages?driverId=${encodeURIComponent(driverId)}` : '/api/driver/packages';
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      return {
        packages: [],
        error: errJson.error || `Erreur serveur HTTP ${resp.status}`
      };
    }

    const json = await resp.json();
    return {
      packages: Array.isArray(json.packages) ? json.packages : [],
      error: null
    };
  } catch (err: any) {
    return {
      packages: [],
      error: err.message || 'Erreur inattendue de connexion aux colis livreur.'
    };
  }
}

export interface CreateClientPayload {
  shopName: string;
  managerName: string;
  phone: string;
  whatsapp?: string;
  email: string;
  city: string;
  address: string;
  activityType?: string;
  isTest?: boolean;
}

/**
 * Creates a real client in Supabase (Auth + public.profiles + public.merchant_shops).
 * Invokes the secure server-side endpoint with admin session token.
 * Never exposes service_role key to the browser.
 */
export async function createSupabaseClient(payload: CreateClientPayload): Promise<{
  success: boolean;
  message?: string;
  client?: UserProfile;
  invitationLink?: string | null;
  error?: string;
  isTest?: boolean;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders
    };

    const resp = await fetch('/api/admin/clients', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status}`
      };
    }

    return {
      success: true,
      message: json.message,
      client: json.client,
      invitationLink: json.invitationLink || null,
      isTest: json.isTest
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la création du client.'
    };
  }
}

/**
 * Checks server configuration for dedicated FARIOUSY TEST Supabase project.
 */
export async function fetchTestEnvStatus(): Promise<{
  configured: boolean;
  productionUrl: string;
  message: string;
}> {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }
    const resp = await fetch('/api/admin/clients/test-env-status', { headers });
    if (resp.ok) {
      const json = await resp.json();
      return {
        configured: Boolean(json.configured),
        productionUrl: json.productionUrl || REAL_SUPABASE_URL,
        message: json.message || ''
      };
    }
  } catch (err) {
    console.warn('[fetchTestEnvStatus notice]', err);
  }
  return {
    configured: false,
    productionUrl: REAL_SUPABASE_URL,
    message: "Environnement TEST non configuré sur le serveur."
  };
}

export interface UpdateClientPayload {
  shopName: string;
  managerName: string;
  phone: string;
  whatsapp?: string;
  city: string;
  address: string;
  activityType?: string;
  bankName?: string;
  bankRib?: string;
}

/**
 * Updates the currently logged-in merchant's profile (including bankName & bankRib)
 */
export async function updateOwnClientProfile(payload: {
  userId?: string;
  companyName?: string;
  name?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  city?: string;
  address?: string;
  bankName?: string;
  bankRib?: string;
}): Promise<{ success: boolean; profile?: UserProfile; error?: string }> {
  try {
    const authHeaders = await getAuthHeaders();
    const resp = await fetch('/api/client/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify(payload)
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status}`
      };
    }
    return { success: true, profile: json.profile };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la sauvegarde du profil.'
    };
  }
}

/**
 * Updates a client in Supabase Production (public.profiles & public.merchant_shops).
 * Uses secure server-side endpoint with admin session token.
 * Never modifies user role or login email.
 */
export async function updateSupabaseClient(
  clientId: string,
  payload: UpdateClientPayload
): Promise<{
  success: boolean;
  message?: string;
  client?: UserProfile;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();

    const resp = await fetch(`/api/admin/clients/${encodeURIComponent(clientId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify(payload)
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status}`
      };
    }

    return {
      success: true,
      message: json.message,
      client: json.client
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la modification du client.'
    };
  }
}

/**
 * Updates only the client's bankName & bankRib cleanly (without requiring shop metadata fields).
 */
export async function updateSupabaseClientBank(
  clientId: string,
  payload: { bankName?: string; bankRib?: string }
): Promise<{
  success: boolean;
  message?: string;
  bankName?: string;
  bankRib?: string;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const resp = await fetch(`/api/admin/clients/${encodeURIComponent(clientId)}/bank`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify(payload)
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status}`
      };
    }

    return {
      success: true,
      message: json.message,
      bankName: json.bankName,
      bankRib: json.bankRib
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors de la sauvegarde du RIB.'
    };
  }
}

/**
 * Suspends or reactivates a client in Supabase Production (public.merchant_shops & public.admin_approvals).
 * Uses secure server-side endpoint with admin session token.
 * Preserves all packages, payments, and histories intact.
 */
export async function toggleSupabaseClientStatus(
  clientId: string,
  newStatus: 'suspendu' | 'approuve' | 'refuse',
  reason?: string
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  try {
    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders
    };

    const resp = await fetch(`/api/admin/clients/${encodeURIComponent(clientId)}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: newStatus, reason })
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) {
      return {
        success: false,
        error: json.error || `Erreur serveur HTTP ${resp.status}`
      };
    }

    return {
      success: true,
      message: json.message
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Erreur réseau lors du changement de statut du client.'
    };
  }
}



export interface RealtimePackageEvent {
  packageId: string;
  trackingNumber: string;
  oldStatus?: string;
  newStatus: string;
  newStatusLabel: string;
  recipientName: string;
  city: string;
  updatedBy: string;
  timestamp: string;
  codAmount: number;
  clientId: string;
}

export interface RealtimePickupEvent {
  pickupId: string;
  trackingId: string;
  clientCompany: string;
  city: string;
  packageCount: number;
  requestedDate: string;
  timeSlot: string;
  timestamp: string;
  clientId: string;
}

export interface RealtimeToastItem {
  id: string;
  title: string;
  message: string;
  type: 'status_changed' | 'new_pickup' | 'new_package';
  timestamp: string;
  badge?: string;
  badgeColor?: string;
  targetId?: string;
}

class SupabaseRealtimeService {
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private crossTabChannel: BroadcastChannel | null = null;
  private listeners: Array<(toast: RealtimeToastItem) => void> = [];
  private statusListeners: Array<(status: 'connected' | 'connecting' | 'disconnected') => void> = [];
  private packageStatusListeners: Array<(event: RealtimePackageEvent) => void> = [];
  public connectionStatus: 'connected' | 'connecting' | 'disconnected' = 'connecting';
  public customUrl: string = '';
  public customKey: string = '';
  public audioEnabled: boolean = true;

  constructor() {
    this.initClient();
    this.initCrossTab();
  }

  private initClient() {
    try {
      const savedUrl = localStorage.getItem('fariousy_supabase_url') || DEFAULT_SUPABASE_URL;
      const savedKey = localStorage.getItem('fariousy_supabase_key') || DEFAULT_SUPABASE_ANON_KEY;
      this.customUrl = savedUrl;
      this.customKey = savedKey;

      if (!savedUrl || !savedKey) {
        this.connectionStatus = 'disconnected';
        this.notifyStatus('disconnected');
        return;
      }

      this.client = createClient(savedUrl, savedKey, {
        realtime: {
          params: {
            eventsPerSecond: 10
          }
        }
      });

      this.setupChannel();
    } catch (e) {
      console.warn('Supabase client initialization notice:', e);
      this.connectionStatus = 'disconnected';
      this.notifyStatus('disconnected');
    }
  }

  private setupChannel() {
    if (!this.client) return;

    try {
      // Subscribe to central broadcast channel 'fariousy-realtime'
      this.channel = this.client.channel('fariousy_realtime_channel', {
        config: {
          broadcast: { self: false } // don't echo to same client instance, crossTab handles tabs
        }
      });

      this.channel
        .on('broadcast', { event: 'package_status_changed' }, ({ payload }) => {
          this.handleIncomingPackageStatus(payload as RealtimePackageEvent);
        })
        .on('broadcast', { event: 'new_pickup_request' }, ({ payload }) => {
          this.handleIncomingPickup(payload as RealtimePickupEvent);
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED') {
            this.connectionStatus = 'connected';
            this.notifyStatus('connected');
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // Do not report connected on channel errors
            this.connectionStatus = 'disconnected';
            this.notifyStatus('disconnected');
          }
        });
    } catch {
      this.connectionStatus = 'disconnected';
      this.notifyStatus('disconnected');
    }
  }

  private initCrossTab() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      this.crossTabChannel = new BroadcastChannel('fariousy_supabase_realtime_local');
      this.crossTabChannel.onmessage = (event) => {
        const { type, payload } = event.data;
        if (type === 'package_status_changed') {
          this.handleIncomingPackageStatus(payload);
        } else if (type === 'new_pickup_request') {
          this.handleIncomingPickup(payload);
        }
      };
      // Local browser channel does not imply remote Supabase connection
    }
  }

  public updateCredentials(url: string, key: string) {
    if (url && key) {
      localStorage.setItem('fariousy_supabase_url', url);
      localStorage.setItem('fariousy_supabase_key', key);
      this.customUrl = url;
      this.customKey = key;
      if (this.channel) {
        this.channel.unsubscribe();
      }
      this.initClient();
    }
  }

  public resetCredentials() {
    localStorage.removeItem('fariousy_supabase_url');
    localStorage.removeItem('fariousy_supabase_key');
    this.customUrl = DEFAULT_SUPABASE_URL;
    this.customKey = DEFAULT_SUPABASE_ANON_KEY;
    this.initClient();
  }

  public getClient(): SupabaseClient | null {
    return this.client;
  }

  // Generic Supabase CRUD synchronizer (respects RLS and handles graceful fallback)
  public async syncRecord(table: string, action: 'insert' | 'update' | 'delete', data: any, idField = 'id') {
    if (!this.client) return { success: false, error: 'Client not initialized' };
    try {
      if (action === 'insert') {
        const { data: res, error } = await this.client.from(table).insert(data).select();
        return { success: !error, data: res, error };
      } else if (action === 'update') {
        const idVal = data[idField];
        const { data: res, error } = await this.client.from(table).update(data).eq(idField, idVal).select();
        return { success: !error, data: res, error };
      } else if (action === 'delete') {
        const idVal = typeof data === 'object' ? data[idField] : data;
        const { data: res, error } = await this.client.from(table).delete().eq(idField, idVal);
        return { success: !error, data: res, error };
      }
      return { success: true };
    } catch (err) {
      // Graceful offline fallback
      return { success: false, error: err };
    }
  }

  // Broadcast package status change
  public broadcastStatusChange(event: RealtimePackageEvent) {
    // 1. Send to Supabase Realtime channel
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'package_status_changed',
        payload: event
      });
    }

    // 2. Send to local cross-tab channel
    if (this.crossTabChannel) {
      this.crossTabChannel.postMessage({
        type: 'package_status_changed',
        payload: event
      });
    }

    // 3. Trigger local toast on this instance as well
    this.handleIncomingPackageStatus(event);
  }

  // Broadcast new pickup request
  public broadcastNewPickup(event: RealtimePickupEvent) {
    // 1. Send to Supabase Realtime channel
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'new_pickup_request',
        payload: event
      });
    }

    // 2. Send to local cross-tab channel
    if (this.crossTabChannel) {
      this.crossTabChannel.postMessage({
        type: 'new_pickup_request',
        payload: event
      });
    }

    // 3. Trigger local toast
    this.handleIncomingPickup(event);
  }

  private handleIncomingPackageStatus(payload: RealtimePackageEvent) {
    this.playAudioNotification(payload.newStatus === 'livre' ? 'success' : payload.newStatus === 'refuse' ? 'alert' : 'info');

    const toast: RealtimeToastItem = {
      id: 'toast-' + Date.now() + Math.random().toString(36).substring(2, 5),
      title: `⚡ Colis ${payload.trackingNumber} : ${payload.newStatusLabel}`,
      message: `Destinataire : ${payload.recipientName} (${payload.city}) · Mis à jour par ${payload.updatedBy}`,
      type: 'status_changed',
      timestamp: payload.timestamp,
      badge: payload.newStatusLabel,
      badgeColor: payload.newStatus === 'livre' ? 'bg-emerald-600' : payload.newStatus === 'refuse' ? 'bg-rose-600' : 'bg-red-600',
      targetId: payload.packageId
    };

    this.notifyToast(toast);

    // Notify all package status listeners
    this.packageStatusListeners.forEach(cb => {
      try {
        cb(payload);
      } catch (err) {
        console.warn('Error in packageStatusListener:', err);
      }
    });
  }

  private handleIncomingPickup(payload: RealtimePickupEvent) {
    this.playAudioNotification('info');

    const toast: RealtimeToastItem = {
      id: 'toast-' + Date.now() + Math.random().toString(36).substring(2, 5),
      title: `📥 Nouveau Ramassage : ${payload.trackingId}`,
      message: `${payload.clientCompany} demande la collecte de ${payload.packageCount} colis (${payload.city}) pour le ${payload.requestedDate}`,
      type: 'new_pickup',
      timestamp: payload.timestamp,
      badge: `${payload.packageCount} colis`,
      badgeColor: 'bg-amber-600',
      targetId: payload.pickupId
    };

    this.notifyToast(toast);
  }

  // Web Audio API notification chime generator (Zero external MP3 dependencies!)
  public playAudioNotification(kind: 'info' | 'success' | 'alert' = 'info') {
    if (!this.audioEnabled || typeof window === 'undefined') return;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      if (kind === 'success') {
        // Joyful ascending dual chime (523Hz -> 659Hz)
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5

        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.15);
        osc2.start(ctx.currentTime + 0.1);
        osc2.stop(ctx.currentTime + 0.35);
      } else if (kind === 'alert') {
        // Warning gentle tone
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.setValueAtTime(330, ctx.currentTime + 0.12);

        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } else {
        // Clean notification bubble chime (587Hz -> 880Hz)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);

        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch {
      // Audio autoplay policy fallback
    }
  }

  // Subscribe to toast alerts
  public onToast(callback: (toast: RealtimeToastItem) => void) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  // Subscribe to package status changes (realtime)
  public onPackageStatusChanged(callback: (event: RealtimePackageEvent) => void) {
    this.packageStatusListeners.push(callback);
    return () => {
      this.packageStatusListeners = this.packageStatusListeners.filter(cb => cb !== callback);
    };
  }

  public onStatusChange(callback: (status: 'connected' | 'connecting' | 'disconnected') => void) {
    this.statusListeners.push(callback);
    callback(this.connectionStatus);
    return () => {
      this.statusListeners = this.statusListeners.filter(cb => cb !== callback);
    };
  }

  private notifyToast(toast: RealtimeToastItem) {
    this.listeners.forEach(cb => cb(toast));
  }

  private notifyStatus(status: 'connected' | 'connecting' | 'disconnected') {
    this.statusListeners.forEach(cb => cb(status));
  }
}

export const supabaseRealtime = new SupabaseRealtimeService();
