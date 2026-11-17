import React, { createContext, useContext, useEffect, useState } from 'react';
import { AccountStatus, UserProfile, UserRole } from '../types';
import { useDatabase } from './DatabaseContext';
import {
  supabaseClient,
  fetchUserProfileFromDb,
  resolveLoginIdentifier,
  getStoredAuthSession,
  saveStoredAuthSession,
  clearStoredAuthSession,
  getRememberMePreference
} from '../services/supabase';
import { saveLocalKycDocs } from '../utils/kycStorage';

export interface LoginResult {
  success: boolean;
  error?: string;
  accountStatus?: AccountStatus | string;
  user?: UserProfile;
}

interface AuthContextType {
  currentUser: UserProfile | null;
  currentRole: UserRole;
  pendingReviewUser: UserProfile | null;
  switchRole: (role: UserRole, specificUserOrId?: string | UserProfile) => void;
  login: (email: string, password?: string, rememberMe?: boolean) => Promise<LoginResult>;
  registerBoutiqueUser: (data: {
    shopName: string;
    managerName: string;
    phone: string;
    whatsapp?: string;
    email: string;
    city: string;
    pickupAddress: string;
    activityType?: string;
    password?: string;
    cinNumber?: string;
    cinPhotoUrl?: string;
    cinBackPhotoUrl?: string;
  }) => Promise<{ success: boolean; user?: UserProfile; error?: string }>;
  logout: () => Promise<void>;
  clearPendingReview: () => void;
  refreshProfile: () => Promise<UserProfile | null>;
  updateCurrentUser: (updates: Partial<UserProfile>) => void;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isEmployee: boolean;
  isDriver: boolean;
  isClient: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  impersonatorAdmin: UserProfile | null;
  isImpersonating: boolean;
  impersonateUser: (targetUser: UserProfile) => void;
  stopImpersonation: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Maps a database row from public.profiles to the client UserProfile object
 */
function mapProfileToUser(profile: any, authUser?: any, overrideRole?: UserRole): UserProfile {
  const role: UserRole = overrideRole || (profile.role as UserRole) || 'client';
  const rawStatus = profile.account_status || profile.accountStatus || profile.status;
  const status: AccountStatus | 'active' = (rawStatus as AccountStatus) || 'approuve';
  const rawShopId = profile.shop_id || profile.shopId || undefined;
  return {
    id: profile.id || authUser?.id || `usr-${Date.now()}`,
    ...(rawShopId ? { shopId: rawShopId } : {}),
    name: profile.full_name || profile.name || authUser?.email?.split('@')[0] || 'Utilisateur',
    email: profile.email || authUser?.email || '',
    role,
    phone: profile.phone || '',
    whatsapp: profile.whatsapp || undefined,
    companyName: profile.company_name || profile.companyName || profile.full_name || profile.name || 'FARIOUSY DELIVERY',
    city: profile.city || 'Casablanca',
    address: profile.address || '',
    bankName: profile.bank_name || profile.bankName || undefined,
    bankRib: profile.bank_rib || profile.bankRib || undefined,
    status,
    accountStatus: (profile.account_status || profile.accountStatus || rawStatus) as AccountStatus,
    statusReason: profile.status_reason || profile.statusReason || undefined,
    registeredAt: profile.created_at || profile.registeredAt || new Date().toISOString()
  };
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { users, registerBoutique } = useDatabase();

  const [pendingReviewUser, setPendingReviewUser] = useState<UserProfile | null>(null);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);
  const [impersonatorAdmin, setImpersonatorAdmin] = useState<UserProfile | null>(() => {
    try {
      if (typeof window !== 'undefined') {
        const saved = sessionStorage.getItem('fariousy_impersonator_admin') || localStorage.getItem('fariousy_impersonator_admin');
        return saved ? JSON.parse(saved) : null;
      }
      return null;
    } catch {
      return null;
    }
  });

  // 1 & 9. Authentification via Supabase Auth + Profil dans public.profiles (Aucun rôle stocké dans localStorage)
  useEffect(() => {
    let isMounted = true;

    async function loadActiveSession() {
      // 1. Check stored session first (sessionStorage or localStorage depending on rememberMe)
      try {
        const parsed = getStoredAuthSession();
        if (parsed && parsed.user) {
          if (isMounted) {
            setCurrentUser(parsed.user);
            setIsAuthLoading(false);
          }

          const isImpersonatingCheck = typeof window !== 'undefined' && !!(
            sessionStorage.getItem('fariousy_impersonator_admin') ||
            localStorage.getItem('fariousy_impersonator_admin')
          );

          // Background verification (uniquement si non impersonné)
          if (parsed.token && !isImpersonatingCheck) {
            fetch('/api/auth/profile', {
              credentials: 'include',
              headers: { Authorization: `Bearer ${parsed.token}` }
            })
              .then(async r => {
                if ((r.status === 401 || r.status === 403) && parsed.token?.startsWith('far_sec_')) {
                  if (typeof window !== 'undefined') {
                    clearStoredAuthSession();
                    window.dispatchEvent(new Event('fariousy_auth_changed'));
                  }
                  if (isMounted) setCurrentUser(null);
                  return null;
                }
                return r.json().catch(() => null);
              })
              .then(d => {
                if (d?.success && d.profile && isMounted) {
                  const mapped = mapProfileToUser(d.profile);
                  setCurrentUser(mapped);
                  saveStoredAuthSession({ token: parsed.token, user: mapped });
                }
              })
              .catch(() => {});
          }
          return;
        }
      } catch (e) {
        console.warn('[Session restore notice]', e);
      }

      // 2. Check Supabase session (skip auto-restore if user explicitly chose not to stay connected)
      if (!getRememberMePreference()) {
        if (isMounted) {
          setCurrentUser(null);
          setIsAuthLoading(false);
        }
        return;
      }
      try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error || !session?.user) {
          if (isMounted) {
            setCurrentUser(null);
            setIsAuthLoading(false);
          }
          return;
        }

        const profile = await fetchUserProfileFromDb(session.user.id, session.access_token);
        if (isMounted) {
          if (profile) {
            const mappedUser = mapProfileToUser(profile, session.user);
            if (typeof window !== 'undefined' && session.access_token) {
              saveStoredAuthSession({ token: session.access_token, user: mappedUser });
            }
            setCurrentUser(mappedUser);
          } else {
            await supabaseClient.auth.signOut();
            setCurrentUser(null);
          }
          setIsAuthLoading(false);
        }
      } catch (err) {
        console.warn('[Auth Initialization notice]', err);
        if (isMounted) {
          setCurrentUser(null);
          setIsAuthLoading(false);
        }
      }
    }

    loadActiveSession();

    // Re-vérification active lors du retour au premier plan de l'application (Focus / Visibilité)
    const handleVisibilityOrFocus = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        try {
          const isImpersonatingCheck = typeof window !== 'undefined' && !!(
            sessionStorage.getItem('fariousy_impersonator_admin') ||
            localStorage.getItem('fariousy_impersonator_admin')
          );
          if (isImpersonatingCheck) return;

          const savedSession = getStoredAuthSession();
          if (savedSession?.token?.startsWith('far_sec_')) {
            return;
          }

          const { data: { session } } = await supabaseClient.auth.getSession();
          if (session?.user) {
            const profile = await fetchUserProfileFromDb(session.user.id, session.access_token);
            if (isMounted && profile) {
              const mappedUser = mapProfileToUser(profile, session.user);
              if (typeof window !== 'undefined' && session.access_token) {
                saveStoredAuthSession({ token: session.access_token, user: mappedUser });
              }
              setCurrentUser(mappedUser);
            }
          }
        } catch (err) {
          console.warn('[Focus profile recheck notice]', err);
        }
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleVisibilityOrFocus);
      document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    }

    // Abonnement aux changements d'état d'authentification Supabase
    const { data: { subscription } } = supabaseClient.auth.onAuthStateChange(async (event, session) => {
      const isImpersonatingCheck = typeof window !== 'undefined' && !!(
        sessionStorage.getItem('fariousy_impersonator_admin') ||
        localStorage.getItem('fariousy_impersonator_admin')
      );
      if (isImpersonatingCheck) return;

      const savedSession = getStoredAuthSession();
      if (savedSession?.token?.startsWith('far_sec_') && savedSession?.user) {
        return;
      }

      if (session?.user) {
        const profile = await fetchUserProfileFromDb(session.user.id, session.access_token);
        if (isMounted) {
          if (profile) {
            const mappedUser = mapProfileToUser(profile, session.user);
            if (typeof window !== 'undefined' && session.access_token) {
              saveStoredAuthSession({ token: session.access_token, user: mappedUser });
            }
            setCurrentUser(mappedUser);
          } else {
            setCurrentUser(null);
          }
        }
      } else if (event === 'SIGNED_OUT') {
        if (isMounted) {
          setCurrentUser(null);
          setPendingReviewUser(null);
        }
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleVisibilityOrFocus);
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      }
    };
  }, []);

  // Dispatcher pour aiguiller selon le statut d'approbation et le rôle
  const handleRoleRouting = (user: UserProfile): LoginResult => {
    // Vérification du statut pour le rôle client
    if (user.role === 'client') {
      const status = user.status;
      if (status === 'en_attente' || status === 'pending') {
        setPendingReviewUser(user);
        return {
          success: false,
          accountStatus: 'en_attente',
          user,
          error: "Votre demande d'inscription Boutique est en cours de validation par l'administration FARIOUSY DELIVERY."
        };
      }

      if (status === 'refuse') {
        setPendingReviewUser(user);
        return {
          success: false,
          accountStatus: 'refuse',
          user,
          error: user.statusReason || "Votre demande d'inscription a été refusée."
        };
      }

      if (status === 'suspendu') {
        setPendingReviewUser(user);
        return {
          success: false,
          accountStatus: 'suspendu',
          user,
          error: user.statusReason || "Votre compte boutique est actuellement suspendu."
        };
      }
    }

    // Vérification du statut pour le rôle livreur
    if (user.role === 'driver') {
      const status = user.status;
      if (status === 'en_attente' || status === 'pending') {
        setPendingReviewUser(user);
        return {
          success: false,
          accountStatus: 'en_attente',
          user,
          error: "Votre demande d'inscription Livreur est en cours de validation par l'administration FARIOUSY DELIVERY. L'accès à l'App Livreur sera activé après approbation."
        };
      }

      if (status === 'refuse') {
        setPendingReviewUser(user);
        return {
          success: false,
          accountStatus: 'refuse',
          user,
          error: user.statusReason || "Votre candidature de livreur n'a pas été retenue par l'administration."
        };
      }

      if (status === 'suspendu') {
        setPendingReviewUser(user);
        return {
          success: false,
          accountStatus: 'suspendu',
          user,
          error: user.statusReason || "Votre compte livreur est actuellement suspendu."
        };
      }
    }

    // Utilisateur approuvé (admin, employee, client, driver)
    setPendingReviewUser(null);
    setCurrentUser(user);
    return {
      success: true,
      user
    };
  };

  /**
   * Connexion principale :
   * 1. Authentification réelle via Supabase Auth
   * 2. Récupération du profil depuis public.profiles
   * 3. Contrôle du champ role et aiguillage
   */
  const login = async (identifier: string, password?: string, rememberMe = true): Promise<LoginResult> => {
    const rawIdentifier = (identifier || '').trim();
    const cleanPassword = (password || '').trim();

    if (!rawIdentifier) {
      return {
        success: false,
        error: "Veuillez saisir votre numéro de téléphone ou votre adresse e-mail."
      };
    }

    if (!cleanPassword) {
      return {
        success: false,
        error: "Veuillez saisir votre mot de passe."
      };
    }

    let targetEmail = rawIdentifier.toLowerCase();

    // Si l'identifiant est un numéro de téléphone (pas de @)
    if (!rawIdentifier.includes('@')) {
      const cleanDigits = rawIdentifier.replace(/\D/g, '');
      // 1. Chercher d'abord dans la liste locale des profils chargés (drivers, clients, etc.)
      const matchedUser = users.find(u => {
        const uPhone = (u.phone || '').replace(/\D/g, '');
        const uWhatsapp = (u.whatsapp || '').replace(/\D/g, '');
        return (
          u.phone === rawIdentifier ||
          (cleanDigits.length >= 8 && uPhone.endsWith(cleanDigits.slice(-8))) ||
          (cleanDigits.length >= 8 && uWhatsapp.endsWith(cleanDigits.slice(-8)))
        );
      });

      if (matchedUser && matchedUser.email) {
        targetEmail = matchedUser.email.toLowerCase();
      } else {
        // 2. Résoudre via le backend /api/auth/resolve-identifier
        const res = await resolveLoginIdentifier(rawIdentifier);
        if (res.success && res.email) {
          targetEmail = res.email.toLowerCase();
        } else {
          targetEmail = `${cleanDigits}@fariousy.com`;
        }
      }
    }

    // 1. Appel prioritaire et strict au endpoint serveur /api/auth/login
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: rawIdentifier, password: cleanPassword, rememberMe })
      });
      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data.success && data.user) {
        const user = data.user;
        const token = data.token;
        try {
          const { data: sbSess } = await supabaseClient.auth.getSession();
          if (sbSess?.session?.user?.email && sbSess.session.user.email.toLowerCase() !== String(user.email || '').toLowerCase()) {
            await supabaseClient.auth.signOut().catch(() => {});
          }
        } catch {}
        if (typeof window !== 'undefined') {
          saveStoredAuthSession({ token, user }, rememberMe);
          try {
            if (rememberMe) {
              localStorage.setItem('fariousy_remembered_identifier', rawIdentifier);
            } else {
              localStorage.removeItem('fariousy_remembered_identifier');
            }
          } catch {}
          window.dispatchEvent(new Event('fariousy_auth_changed'));
        }
        setCurrentUser(user);
        setPendingReviewUser(null);
        return handleRoleRouting(user);
      }

      // If server explicitly rejected credentials or account status, do NOT bypass via weak local fallback
      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        return {
          success: false,
          accountStatus: data.accountStatus,
          error: data.error || 'Numéro de téléphone / e-mail ou mot de passe incorrect.'
        };
      }
    } catch (apiErr) {
      console.warn('[Server Login API unreachable, trying Supabase Auth]', apiErr);
    }

    // 2. Vérification locale stricte uniquement si mot de passe explicitement défini (sans aucun bypass >= 6)
    if (typeof window !== 'undefined') {
      try {
        const savedUsersRaw = localStorage.getItem('fariousy_users_v1');
        const localList: UserProfile[] = savedUsersRaw ? JSON.parse(savedUsersRaw) : users;
        const cleanDigits = rawIdentifier.replace(/\D/g, '');

        const localMatch = localList.find(u => {
          const emailMatch = (u.email || '').toLowerCase() === rawIdentifier.toLowerCase();
          const uPhone = (u.phone || '').replace(/\D/g, '');
          const uWhatsapp = (u.whatsapp || '').replace(/\D/g, '');
          const phoneMatch = cleanDigits.length >= 8 && (uPhone.endsWith(cleanDigits.slice(-8)) || uWhatsapp.endsWith(cleanDigits.slice(-8)));
          return emailMatch || phoneMatch;
        });

        if (localMatch && localMatch.password && localMatch.password === cleanPassword) {
          const token = `far_sec_${localMatch.id}_${Date.now()}`;
          saveStoredAuthSession({ token, user: localMatch }, rememberMe);
          try {
            if (rememberMe) {
              localStorage.setItem('fariousy_remembered_identifier', rawIdentifier);
            } else {
              localStorage.removeItem('fariousy_remembered_identifier');
            }
          } catch {}
          window.dispatchEvent(new Event('fariousy_auth_changed'));
          setCurrentUser(localMatch);
          setPendingReviewUser(null);
          return handleRoleRouting(localMatch);
        }
      } catch (localErr) {
        console.warn('[Local client login match warning]', localErr);
      }
    }

    let authUser: any = null;
    let accessToken: string | undefined;

    // 3. Fallback Supabase Client direct
    try {
      const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
        email: targetEmail,
        password: cleanPassword
      });

      if (authError || !authData.user) {
        const msg = authError?.message || '';
        let translatedError = "Numéro de téléphone / e-mail ou mot de passe incorrect.";
        if (msg.includes('Invalid login credentials')) {
          translatedError = "Numéro de téléphone / e-mail ou mot de passe incorrect.";
        } else if (msg.includes('Email not confirmed')) {
          translatedError = "Veuillez confirmer votre compte avant de vous connecter.";
        } else if (msg) {
          translatedError = msg;
        }

        return {
          success: false,
          error: translatedError
        };
      }

      authUser = authData.user;
      accessToken = authData.session?.access_token;
    } catch (err: any) {
      return {
        success: false,
        error: `Erreur lors de la communication avec Supabase Auth : ${err.message}`
      };
    }

    // 3. Récupération du profil depuis public.profiles via son identifiant Supabase Auth
    const profile = await fetchUserProfileFromDb(authUser.id, accessToken);

    // 8. Si aucun profil n'existe, message d'erreur clair SANS attribuer le rôle Administrateur
    if (!profile) {
      await supabaseClient.auth.signOut();
      setCurrentUser(null);
      return {
        success: false,
        error: "Compte authentifié sur Supabase, mais aucun profil utilisateur n'a été trouvé dans la table public.profiles. L'accès n'est pas autorisé. Veuillez contacter l'administrateur."
      };
    }

    // 3. Vérification du champ role
    const rawRole = (profile.role || '').toLowerCase().trim();
    let mappedRole: UserRole;
    if (rawRole === 'super_admin' || rawRole === 'superadmin') {
      mappedRole = 'super_admin';
    } else if (rawRole === 'admin') {
      mappedRole = 'admin';
    } else if (rawRole === 'employee' || rawRole === 'ops') {
      mappedRole = 'employee';
    } else if (rawRole === 'driver' || rawRole === 'livreur') {
      mappedRole = 'driver';
    } else if (rawRole === 'client' || rawRole === 'boutique') {
      mappedRole = 'client';
    } else {
      await supabaseClient.auth.signOut();
      setCurrentUser(null);
      return {
        success: false,
        error: `Rôle utilisateur "${rawRole}" non reconnu. Accès refusé.`
      };
    }

    const userProfile: UserProfile = mapProfileToUser(profile, authUser, mappedRole);

    if (typeof window !== 'undefined' && accessToken) {
      saveStoredAuthSession({ token: accessToken, user: userProfile }, rememberMe);
      try {
        if (rememberMe) {
          localStorage.setItem('fariousy_remembered_identifier', rawIdentifier);
        } else {
          localStorage.removeItem('fariousy_remembered_identifier');
        }
      } catch {}
      window.dispatchEvent(new Event('fariousy_auth_changed'));
    }

    // 4-7. Aiguillage automatique selon le rôle (admin -> Admin Dashboard, etc.)
    return handleRoleRouting(userProfile);
  };

  const switchRole = (role: UserRole, specificUserOrId?: string | UserProfile) => {
    // Only authenticated admin/staff or active impersonation can switch views
    if (!currentUser && !impersonatorAdmin) return;
    const isCallerPrivileged = Boolean(
      impersonatorAdmin ||
      currentUser?.role === 'super_admin' ||
      currentUser?.role === 'admin' ||
      currentUser?.role === 'employee'
    );
    if (!isCallerPrivileged) return;

    setPendingReviewUser(null);

    const resolveTokenForUser = (): string | undefined => {
      if (typeof window !== 'undefined') {
        try {
          const impToken =
            sessionStorage.getItem('fariousy_impersonator_token') ||
            localStorage.getItem('fariousy_impersonator_token');
          if (impToken) return impToken;
          const saved = getStoredAuthSession();
          const existingToken = saved?.token;
          if (existingToken && typeof existingToken === 'string') {
            return existingToken;
          }
        } catch {}
      }
      return undefined;
    };

    // 1. If a full UserProfile object was passed directly
    if (specificUserOrId && typeof specificUserOrId === 'object' && specificUserOrId.id) {
      const targetUser: UserProfile = {
        ...specificUserOrId,
        role: role || specificUserOrId.role
      };

      if (typeof window !== 'undefined') {
        const token = resolveTokenForUser();
        saveStoredAuthSession({ token, user: targetUser });
        window.dispatchEvent(new Event('fariousy_auth_changed'));
      }

      setCurrentUser(targetUser);
      return;
    }

    // 2. If an ID string was passed
    if (typeof specificUserOrId === 'string' && specificUserOrId.trim()) {
      const targetUser = users.find(u => u.id === specificUserOrId);
      if (targetUser) {
        if (typeof window !== 'undefined') {
          const token = resolveTokenForUser();
          saveStoredAuthSession({ token, user: targetUser });
          window.dispatchEvent(new Event('fariousy_auth_changed'));
        }
        setCurrentUser(targetUser);
        return;
      }
    }

    // 3. Return to impersonatorAdmin if switching back to admin
    if ((role === 'admin' || role === 'super_admin') && impersonatorAdmin) {
      if (typeof window !== 'undefined') {
        const token = resolveTokenForUser();
        saveStoredAuthSession({ token, user: impersonatorAdmin });
        window.dispatchEvent(new Event('fariousy_auth_changed'));
      }
      setCurrentUser(impersonatorAdmin);
      return;
    }

    // 4. Find existing authenticated user with that role
    const firstMatching =
      users.find(u => u.role === role && (u.status === 'active' || u.status === 'approuve')) ||
      users.find(u => u.role === role);
    if (firstMatching) {
      if (typeof window !== 'undefined') {
        const token = resolveTokenForUser();
        saveStoredAuthSession({ token, user: firstMatching });
        window.dispatchEvent(new Event('fariousy_auth_changed'));
      }
      setCurrentUser(firstMatching);
    }
  };

  const registerBoutiqueUser = async (data: {
    shopName: string;
    managerName: string;
    phone: string;
    whatsapp?: string;
    email: string;
    city: string;
    pickupAddress: string;
    activityType?: string;
    password?: string;
    cinNumber?: string;
    cinPhotoUrl?: string;
    cinBackPhotoUrl?: string;
  }): Promise<{ success: boolean; user?: UserProfile; error?: string }> => {
    try {
      const resp = await fetch('/api/auth/register-client', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const res = await resp.json().catch(() => ({}));
      if (!resp.ok || !res.success) {
        return { success: false, error: res.error || "Erreur lors de l'inscription." };
      }

      const createdUser: UserProfile = {
        ...res.user,
        cinNumber: res.user?.cinNumber || data.cinNumber,
        cinPhotoUrl: res.user?.cinPhotoUrl || data.cinPhotoUrl,
        cinBackPhotoUrl: res.user?.cinBackPhotoUrl || data.cinBackPhotoUrl
      };

      if (data.cinPhotoUrl || data.cinBackPhotoUrl || data.cinNumber) {
        saveLocalKycDocs([createdUser.id, (createdUser as any).shopId, data.email], {
          cinNumber: data.cinNumber,
          cinPhotoUrl: data.cinPhotoUrl,
          cinBackPhotoUrl: data.cinBackPhotoUrl
        });
      }

      if (res.pendingApproval || !res.token) {
        setPendingReviewUser(createdUser);
        setCurrentUser(null);
        return { success: true, user: createdUser };
      }

      setPendingReviewUser(null);

      // Enregistrer la session uniquement si le compte est approuvé immédiatement
      if (typeof window !== 'undefined' && res.token) {
        saveStoredAuthSession({ token: res.token, user: createdUser });
        window.dispatchEvent(new Event('fariousy_auth_changed'));
      }
      setCurrentUser(createdUser);

      return { success: true, user: createdUser };
    } catch (err: any) {
      return { success: false, error: err.message || "Erreur réseau lors de l'inscription." };
    }
  };

  const logout = async () => {
    try {
      const stored = typeof window !== 'undefined' ? getStoredAuthSession() : null;
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: stored?.token ? { Authorization: `Bearer ${stored.token}` } : {}
      }).catch(() => {});
      if (typeof window !== 'undefined') {
        clearStoredAuthSession();
        sessionStorage.removeItem('fariousy_impersonator_admin');
        localStorage.removeItem('fariousy_impersonator_admin');
        sessionStorage.removeItem('fariousy_impersonator_token');
        localStorage.removeItem('fariousy_impersonator_token');
        // Clear any driver override params from URL
        const url = new URL(window.location.href);
        if (url.searchParams.has('app') || url.searchParams.has('mode')) {
          url.searchParams.delete('app');
          url.searchParams.delete('mode');
          window.history.replaceState({}, '', url.pathname);
        }
      }
      await supabaseClient.auth.signOut();
    } catch {
      // Ignorer l'erreur silencieusement en déconnexion
    } finally {
      setImpersonatorAdmin(null);
      setCurrentUser(null);
      setPendingReviewUser(null);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('fariousy_auth_changed'));
      }
    }
  };

  const refreshProfile = async (): Promise<UserProfile | null> => {
    try {
      // 1. If impersonating, NEVER kick out or clear session!
      if (isImpersonating || impersonatorAdmin) {
        return currentUser;
      }

      // 2. Check stored session
      const parsed = getStoredAuthSession();
      const localUser: UserProfile | null = parsed?.user || null;
      const token: string | undefined = parsed?.token;

      // If we have a server token, attempt strict refresh
      if (token && token.startsWith('far_sec_')) {
        try {
          const res = await fetch('/api/auth/profile', {
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}` }
          });
          if (res.status === 401 || res.status === 403) {
            if (typeof window !== 'undefined') {
              clearStoredAuthSession();
              window.dispatchEvent(new Event('fariousy_auth_changed'));
            }
            setCurrentUser(null);
            return null;
          }
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.success && data.profile) {
            const mapped = mapProfileToUser(data.profile);
            setCurrentUser(mapped);
            saveStoredAuthSession({ token, user: mapped });
            return mapped;
          }
        } catch {}
      }

      // 3. Check Supabase session
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session?.user) {
        const profile = await fetchUserProfileFromDb(session.user.id, session.access_token);
        if (profile) {
          const mappedUser = mapProfileToUser(profile, session.user);
          if (typeof window !== 'undefined' && session.access_token) {
            saveStoredAuthSession({ token: session.access_token, user: mappedUser });
          }
          setCurrentUser(mappedUser);
          return mappedUser;
        }
      }

      if (currentUser) {
        return currentUser;
      }
      if (localUser) {
        setCurrentUser(localUser);
        return localUser;
      }

      setCurrentUser(null);
      return null;
    } catch (e) {
      console.warn('[RefreshProfile notice]', e);
      return currentUser;
    }
  };

  const updateCurrentUser = (updates: Partial<UserProfile>) => {
    setCurrentUser(prev => {
      if (!prev) return prev;
      const merged = { ...prev, ...updates };
      if (typeof window !== 'undefined') {
        const parsed = getStoredAuthSession();
        saveStoredAuthSession({ token: parsed?.token, user: merged });
      }
      return merged;
    });
  };

  const clearPendingReview = () => {
    setPendingReviewUser(null);
  };

  const isImpersonating = impersonatorAdmin !== null;

  const impersonateUser = (targetUser: UserProfile) => {
    if (!currentUser) return;

    const clientToImpersonate: UserProfile = {
      ...targetUser,
      role: targetUser.role || 'client'
    };

    // Preserve the original admin / staff user
    const adminToSave =
      impersonatorAdmin ||
      (currentUser.role === 'admin' || currentUser.role === 'super_admin' || currentUser.role === 'employee'
        ? currentUser
        : null);
    if (!adminToSave) return;

    setImpersonatorAdmin(adminToSave);
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem('fariousy_impersonator_admin', JSON.stringify(adminToSave));
        localStorage.setItem('fariousy_impersonator_admin', JSON.stringify(adminToSave));

        const saved = getStoredAuthSession();
        let token = saved?.token;
        if (!token) {
          token =
            sessionStorage.getItem('fariousy_impersonator_token') ||
            localStorage.getItem('fariousy_impersonator_token') ||
            `far_sec_${adminToSave.id}_${Date.now()}`;
        }
        if (token) {
          sessionStorage.setItem('fariousy_impersonator_token', token);
          localStorage.setItem('fariousy_impersonator_token', token);
        }
        saveStoredAuthSession({ token, user: clientToImpersonate });
      } catch {
        // ignore
      }
    }

    setPendingReviewUser(null);
    setCurrentUser(clientToImpersonate);
  };

  const stopImpersonation = () => {
    if (!impersonatorAdmin) return;

    const restoredAdmin = impersonatorAdmin;
    setImpersonatorAdmin(null);
    if (typeof window !== 'undefined') {
      try {
        const preservedToken =
          sessionStorage.getItem('fariousy_impersonator_token') ||
          localStorage.getItem('fariousy_impersonator_token');
        sessionStorage.removeItem('fariousy_impersonator_admin');
        localStorage.removeItem('fariousy_impersonator_admin');
        sessionStorage.removeItem('fariousy_impersonator_token');
        localStorage.removeItem('fariousy_impersonator_token');

        const saved = getStoredAuthSession();
        const token = preservedToken || saved?.token;
        saveStoredAuthSession({ token, user: restoredAdmin });
      } catch {
        // ignore
      }
    }

    setPendingReviewUser(null);
    setCurrentUser(restoredAdmin);
  };

  // 4-7. Rôles stricts : aucun rôle actif si l'utilisateur n'est pas authentifié
  const currentRole: UserRole = currentUser ? currentUser.role : 'client';
  const isSuperAdmin = currentUser !== null && (currentRole === 'super_admin' || currentUser.email === 'wadarazzeddine30@gmail.com');
  const isAdmin = currentUser !== null && (currentRole === 'admin' || currentRole === 'super_admin');
  const isEmployee = currentUser !== null && currentRole === 'employee';
  const isDriver = currentUser !== null && currentRole === 'driver';
  const isClient = currentUser !== null && currentRole === 'client';
  const isAuthenticated = currentUser !== null;

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        currentRole,
        pendingReviewUser,
        switchRole,
        login,
        registerBoutiqueUser,
        logout,
        clearPendingReview,
        refreshProfile,
        updateCurrentUser,
        isSuperAdmin,
        isAdmin,
        isEmployee,
        isDriver,
        isClient,
        isAuthenticated,
        isAuthLoading,
        impersonatorAdmin,
        isImpersonating,
        impersonateUser,
        stopImpersonation
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
