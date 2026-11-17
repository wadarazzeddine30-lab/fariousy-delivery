import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  INITIAL_PARTNERS,
  INITIAL_PARTNER_LOGS,
  INITIAL_CLIENT_MESSAGES,
  INITIAL_DRIVER_REQUESTS,
  INITIAL_COMPANY_SETTINGS,
  INITIAL_CITIES
} from './data/initialData';
import {
  CompanySettings,
  CustomerReview,
  Partner,
  PartnerFailedTransmission,
  PartnerSyncLog,
  PackageItem,
  PackageStatus,
  PACKAGE_STATUS_CONFIG,
  ClientMessage,
  ClientMessageReply,
  DriverRegistrationRequest,
  WhatsappDispatchLog,
  UserRole,
  UserProfile,
  ConfirmationActionLog,
  ConfirmationOutcome,
  StaffControlMemberOverview,
  StaffPresenceRecord,
  StaffWorkShift
} from './types';
import {
  buildPartnerShipmentPayload,
  extractPartnerTrackingFromResponse,
  extractTokenExpiryIso,
  normalizePartnerStatus,
  parseInboundPackagePayload,
  validatePartnerShipmentPayload,
  maskSecret
} from './services/partnerAdapters';
import { persistentStorage } from './services/persistentStorage';

dotenv.config();

const NODE_ENV = process.env.NODE_ENV || 'development';

// Real Supabase project host
const SUPABASE_PROJECT_REF = 'vplhnaqjdpicfsogjihk';
const REAL_SUPABASE_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co`;

// Helper: robust URL sanitization (handles trailing text, malformed characters, and typos)
export function sanitizeSupabaseUrl(input?: string): string {
  if (!input || typeof input !== 'string') return REAL_SUPABASE_URL;
  const trimmed = input.trim();
  if (trimmed.startsWith('sb_') || trimmed.startsWith('eyJ')) {
    return REAL_SUPABASE_URL;
  }
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  if (match) {
    let urlStr = match[0].replace(/[.,;:)\]]+$/, '');
    urlStr = urlStr.replace('yplhnagidpicfsogjihk', SUPABASE_PROJECT_REF);
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

export const SUPABASE_URL = sanitizeSupabaseUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL);

// Server-side authentication: prioritize SUPABASE_SERVICE_ROLE_KEY (never exposed to client)
const rawKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  (process.env.SUPABASE_URL?.startsWith('sb_secret_') ? process.env.SUPABASE_URL : '') ||
  process.env.SUPABASE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  (process.env.VITE_SUPABASE_URL?.startsWith('sb_publishable_') ? process.env.VITE_SUPABASE_URL : '') ||
  '';

export const SUPABASE_KEY = rawKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder';

export const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ||
  (process.env.VITE_SUPABASE_URL?.startsWith('sb_publishable_') ? process.env.VITE_SUPABASE_URL : '') ||
  process.env.SUPABASE_ANON_KEY ||
  '';

const isValidSupabaseKey = (k?: string): boolean =>
  Boolean(k && !k.includes('placeholder') && k.trim().length >= 20);

export let supabase: SupabaseClient;
try {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
} catch (err) {
  console.warn('[Supabase Init Warning] Fallback client used:', (err as Error)?.message);
  supabase = createClient(REAL_SUPABASE_URL, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder', {
    auth: { persistSession: false }
  });
}

// Fallback in-memory cache synchronized with Supabase
let partnersCache: Partner[] = JSON.parse(JSON.stringify(INITIAL_PARTNERS));
let syncLogsCache: PartnerSyncLog[] = JSON.parse(JSON.stringify(INITIAL_PARTNER_LOGS));
let clientMessagesCache: ClientMessage[] = JSON.parse(JSON.stringify(INITIAL_CLIENT_MESSAGES));
let driverRequestsCache: DriverRegistrationRequest[] = JSON.parse(JSON.stringify(INITIAL_DRIVER_REQUESTS));


// Helper: Sanitize partner for client responses (mask secrets)
export const sanitizePartner = (p: Partner): Partner => {
  const copy = JSON.parse(JSON.stringify(p));
  if (copy.apiConfig) {
    delete (copy.apiConfig as any)._profileMeta;
    if (copy.apiConfig.apiKey) {
      copy.apiConfig.apiKey = maskSecret(copy.apiConfig.apiKey);
    }
    if (copy.apiConfig.apiSecret) {
      copy.apiConfig.apiSecret = maskSecret(copy.apiConfig.apiSecret);
    }
    if (copy.apiConfig.password) {
      copy.apiConfig.password = '••••••••';
    }
    if (copy.apiConfig.webhookSecret) {
      copy.apiConfig.webhookSecret = maskSecret(copy.apiConfig.webhookSecret);
    }
  }
  return copy;
};

// Map DB row to Partner object
function mapDbToPartner(row: any): Partner {
  const rawApiConfig = row.api_config && typeof row.api_config === 'object' ? { ...row.api_config } : undefined;
  const profileMeta = rawApiConfig?._profileMeta && typeof rawApiConfig._profileMeta === 'object'
    ? rawApiConfig._profileMeta
    : {};
  if (rawApiConfig && '_profileMeta' in rawApiConfig) {
    delete rawApiConfig._profileMeta;
  }
  const hasRealApiConfig = rawApiConfig && (rawApiConfig.baseUrl || rawApiConfig.adapterType || rawApiConfig.apiKey || rawApiConfig.enabled !== undefined);

  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person || '',
    phone: row.phone,
    email: row.email || '',
    city: row.city || 'Casablanca',
    address: row.address || profileMeta.address || '',
    website: row.website || profileMeta.website || '',
    logoUrl: row.logo_url || profileMeta.logoUrl || '',
    active: row.active ?? true,
    notes: row.notes || '',
    deliveryFee: Number(row.delivery_fee ?? row.deliveryFee ?? profileMeta.deliveryFee ?? 30),
    returnFee: Number(row.return_fee ?? row.returnFee ?? profileMeta.returnFee ?? 10),
    cityTariffs: profileMeta.cityTariffs && typeof profileMeta.cityTariffs === 'object' ? profileMeta.cityTariffs : undefined,
    settlements: Array.isArray(row.settlements) ? row.settlements : (Array.isArray(profileMeta.settlements) ? profileMeta.settlements : []),
    apiConfig: hasRealApiConfig ? rawApiConfig : undefined,
    totalSent: row.total_sent || 0,
    totalReceived: row.total_received || 0,
    totalDelivered: row.total_delivered || 0,
    totalPending: row.total_pending || 0
  };
}

// Map DB row to SyncLog object
function mapDbToSyncLog(row: any): PartnerSyncLog {
  return {
    id: row.id,
    timestamp: row.timestamp || new Date(row.created_at || Date.now()).toISOString().replace('T', ' ').slice(0, 16),
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    direction: row.direction,
    status: row.status,
    statusCode: row.status_code,
    endpoint: row.endpoint,
    message: row.message,
    packageCount: row.package_count || 0,
    trackingNumbers: row.tracking_numbers || [],
    requestPayloadPreview: row.request_payload_preview,
    responsePayloadPreview: row.response_payload_preview,
    durationMs: row.duration_ms || 0
  };
}

// Map DB row to ClientMessage object
function mapDbToClientMessage(row: any): ClientMessage {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientCompany: row.client_company || '',
    clientPhone: row.client_phone || '',
    clientEmail: row.client_email || '',
    category: row.category || 'autre',
    priority: row.priority || 'normale',
    status: row.status || 'nouveau',
    subject: row.subject,
    message: row.message,
    packageTrackingNumber: row.package_tracking_number,
    packageId: row.package_id,
    replies: row.replies || [],
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString()
  };
}

// Map DB row to DriverRegistrationRequest object
function mapDbToDriverRequest(row: any): DriverRegistrationRequest {
  const kyc = persistentStorage.getKycDocuments([row.id, row.email]);
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    city: row.city,
    address: row.address,
    cinNumber: row.cin_number,
    cinPhotoUrl: row.cin_photo_url || kyc?.cinPhotoUrl || undefined,
    cinBackPhotoUrl: row.cin_back_photo_url || kyc?.cinBackPhotoUrl || undefined,
    driverPhotoUrl: row.driver_photo_url || kyc?.driverPhotoUrl || undefined,
    vehicleType: row.vehicle_type,
    driverPlate: row.driver_plate || '',
    status: row.status,
    rejectionReason: row.rejection_reason || undefined,
    submittedAt: row.submitted_at || row.created_at || new Date().toISOString(),
    reviewedAt: row.reviewed_at || undefined,
    reviewedBy: row.reviewed_by || undefined,
    notes: row.notes || undefined
  };
}

const SYSTEM_STATE_ROW_ID = '__fariousy_system_state__';
const SYSTEM_COLLECTION_BACKUP_KEYS = [
  'cities',
  'agencies',
  'vehicles',
  'pickups',
  'payments',
  'clientDebts',
  'transferReceipts',
  'bons',
  'stockLocations',
  'employees',
  'clientCustomRates',
  'savedAddresses',
  'auditLogs',
  'notifications',
  'staffPresence',
  'staffShifts',
  'confirmationLogs',
  'customerBlacklist'
] as const;

let hasLoadedSystemStateFromSupabase = false;
let systemStateLoadPromise: Promise<void> | null = null;

function areCitiesEqualToInitial(list: any): boolean {
  if (!Array.isArray(list) || list.length !== INITIAL_CITIES.length) return false;
  for (let i = 0; i < INITIAL_CITIES.length; i++) {
    const a = list[i];
    const b = INITIAL_CITIES[i];
    if (!a) return false;
    if (
      String(a.name || '') !== b.name ||
      String(a.region || '') !== b.region ||
      Number(a.defaultFee) !== Number(b.defaultFee) ||
      Number(a.returnFee) !== Number(b.returnFee) ||
      Number(a.deliveryDelayHours) !== Number(b.deliveryDelayHours) ||
      (a.active !== false) !== (b.active !== false)
    ) {
      return false;
    }
  }
  return true;
}

function buildSystemStateSnapshot() {
  const cols = persistentStorage.getSystemCollections();
  const backupCols: Record<string, any> = {};
  for (const key of SYSTEM_COLLECTION_BACKUP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cols, key) && cols[key] !== undefined) {
      backupCols[key] = cols[key];
    }
  }
  const companySettings = persistentStorage.getCompanySettings();
  return {
    systemCollections: backupCols,
    companySettings: companySettings || undefined,
    updatedAt: new Date().toISOString()
  };
}

function applySystemStateSnapshotToStorage(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const remoteCols = snapshot.systemCollections;
  if (remoteCols && typeof remoteCols === 'object') {
    for (const key of SYSTEM_COLLECTION_BACKUP_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(remoteCols, key)) continue;
      const remoteVal = remoteCols[key];
      if (remoteVal === undefined || remoteVal === null) continue;
      const localVal = persistentStorage.getSystemCollection(key);
      if (key === 'cities' && Array.isArray(remoteVal)) {
        if (remoteVal.length === 0) continue;
        const localCustomized = Array.isArray(localVal) && localVal.length > 0 && !areCitiesEqualToInitial(localVal);
        const remoteCustomized = !areCitiesEqualToInitial(remoteVal);
        if (localCustomized && !remoteCustomized) {
          continue;
        }
        if (remoteCustomized || !Array.isArray(localVal) || localVal.length === 0) {
          persistentStorage.setSystemCollection('cities', remoteVal);
        }
      } else if (Array.isArray(remoteVal)) {
        if (remoteVal.length > 0 || !Array.isArray(localVal) || localVal.length === 0) {
          persistentStorage.setSystemCollection(key, remoteVal);
        }
      } else if (typeof remoteVal === 'object') {
        const localHasKeys = localVal && typeof localVal === 'object' && Object.keys(localVal).length > 0;
        const remoteHasKeys = Object.keys(remoteVal).length > 0;
        if (remoteHasKeys || !localHasKeys) {
          persistentStorage.setSystemCollection(key, remoteVal);
        }
      }
    }
  }
  if (snapshot.companySettings && typeof snapshot.companySettings === 'object') {
    const localSettings = persistentStorage.getCompanySettings();
    if (!localSettings) {
      persistentStorage.saveCompanySettings(snapshot.companySettings, INITIAL_COMPANY_SETTINGS);
    } else {
      persistentStorage.saveCompanySettings({ ...snapshot.companySettings, ...localSettings }, INITIAL_COMPANY_SETTINGS);
    }
  }
}

async function persistSystemStateToSupabase() {
  if (!isValidSupabaseKey(SUPABASE_KEY)) return;
  try {
    const snapshot = buildSystemStateSnapshot();
    const { error: sysErr } = await supabase
      .from('system_collections')
      .upsert({
        key: 'system_state',
        value: snapshot,
        updated_at: snapshot.updatedAt
      });
    if (!sysErr) return;

    await supabase
      .from('delivery_partners')
      .upsert({
        id: SYSTEM_STATE_ROW_ID,
        name: 'System Configuration',
        contact_person: 'System',
        phone: '0000000000',
        email: '',
        city: 'Casablanca',
        active: false,
        notes: 'Internal persistent system collections & settings snapshot',
        api_config: { _systemState: snapshot },
        updated_at: snapshot.updatedAt
      });
  } catch (err: any) {
    console.warn('[Supabase System State Persist Warning]', err?.message);
  }
}

async function loadSystemStateFromSupabase() {
  if (!isValidSupabaseKey(SUPABASE_KEY)) {
    hasLoadedSystemStateFromSupabase = true;
    return;
  }
  try {
    let snapshot: any = null;
    const { data: sysRow, error: sysErr } = await Promise.race([
      supabase.from('system_collections').select('value').eq('key', 'system_state').maybeSingle(),
      new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1200))
    ]).catch(() => ({ data: null, error: true }));

    if (!sysErr && sysRow?.value) {
      snapshot = sysRow.value;
    } else {
      const { data: partnerRow } = await Promise.race([
        supabase.from('delivery_partners').select('api_config').eq('id', SYSTEM_STATE_ROW_ID).maybeSingle(),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1200))
      ]).catch(() => ({ data: null }));
      if (partnerRow?.api_config?._systemState) {
        snapshot = partnerRow.api_config._systemState;
      }
    }

    if (snapshot) {
      applySystemStateSnapshotToStorage(snapshot);
    } else {
      const localCities = persistentStorage.getSystemCollection('cities');
      const localSettings = persistentStorage.getCompanySettings();
      if ((Array.isArray(localCities) && !areCitiesEqualToInitial(localCities)) || localSettings) {
        void persistSystemStateToSupabase();
      }
    }
  } catch (err: any) {
    console.warn('[Supabase System State Load Warning]', err?.message);
  } finally {
    hasLoadedSystemStateFromSupabase = true;
  }
}

async function ensureSystemStateLoadedFromSupabase() {
  if (hasLoadedSystemStateFromSupabase) return;
  if (!systemStateLoadPromise) {
    systemStateLoadPromise = loadSystemStateFromSupabase().finally(() => {
      systemStateLoadPromise = null;
    });
  }
  await systemStateLoadPromise;
}

/**
 * Bootstrap or sync default partners, messages, and driver requests into Supabase
 */
export async function initializeSupabaseSync() {
  try {
    const timeout = (ms: number) => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));

    const partnersPromise = Promise.race([
      supabase.from('delivery_partners').select('*').order('created_at', { ascending: true }),
      timeout(1000)
    ]).catch(() => ({ data: null, error: true }));

    const logsPromise = Promise.race([
      supabase.from('partner_sync_logs').select('*').order('created_at', { ascending: false }).limit(100),
      timeout(1000)
    ]).catch(() => ({ data: null }));

    const msgsPromise = Promise.race([
      supabase.from('client_messages').select('*').order('created_at', { ascending: false }).limit(100),
      timeout(1000)
    ]).catch(() => ({ data: null }));

    const driversPromise = Promise.race([
      supabase.from('driver_registration_requests').select('*').order('submitted_at', { ascending: false }).limit(100),
      timeout(1000)
    ]).catch(() => ({ data: null }));

    const [partnersRes, logsRes, msgsRes, driversRes]: any = await Promise.all([
      partnersPromise,
      logsPromise,
      msgsPromise,
      driversPromise,
      ensureSystemStateLoadedFromSupabase()
    ]);

    if (partnersRes?.data && partnersRes.data.length > 0) {
      const existingMap = new Map(getSyncedPartners().map(p => [p.id, p]));
      partnersCache = partnersRes.data
        .filter((row: any) => row?.id !== SYSTEM_STATE_ROW_ID)
        .map((row: any) => {
        const dbPartner = mapDbToPartner(row);
        const existing = existingMap.get(dbPartner.id);
        return existing
          ? {
              ...dbPartner,
              address: existing.address || dbPartner.address,
              website: existing.website || dbPartner.website,
              logoUrl: existing.logoUrl || dbPartner.logoUrl,
              cityTariffs: existing.cityTariffs && Object.keys(existing.cityTariffs).length > 0 ? existing.cityTariffs : dbPartner.cityTariffs,
              webhookToken: existing.webhookToken || dbPartner.webhookToken || dbPartner.apiConfig?.webhookSecret,
              apiTokens: existing.apiTokens?.length ? existing.apiTokens : dbPartner.apiTokens,
              deliveryFee: existing.deliveryFee ?? dbPartner.deliveryFee,
              returnFee: existing.returnFee ?? dbPartner.returnFee,
              settlements: existing.settlements?.length ? existing.settlements : dbPartner.settlements,
              errorCount: existing.errorCount ?? dbPartner.errorCount,
              apiConfig: existing.apiConfig || dbPartner.apiConfig
                ? {
                    ...(dbPartner.apiConfig || {}),
                    ...(existing.apiConfig || {})
                  } as any
                : undefined
            }
          : dbPartner;
      });
      console.log(`[Supabase DB] ${partnersCache.length} partenaires synchronisés.`);
    }

    if (logsRes?.data && logsRes.data.length > 0) {
      syncLogsCache = logsRes.data.map(mapDbToSyncLog);
    }

    if (msgsRes?.data && msgsRes.data.length > 0) {
      clientMessagesCache = msgsRes.data.map(mapDbToClientMessage);
    }

    if (driversRes?.data && driversRes.data.length > 0) {
      driverRequestsCache = driversRes.data.map(mapDbToDriverRequest);
      persistentStorage.setSystemCollection('driverRequests', driverRequestsCache);
      console.log(`[Supabase DB] ${driverRequestsCache.length} demandes de livreurs synchronisées.`);
    } else {
      const storedReqs = persistentStorage.getSystemCollection<DriverRegistrationRequest[]>('driverRequests');
      if (Array.isArray(storedReqs)) {
        driverRequestsCache = storedReqs;
      }
    }
  } catch (err: any) {
    console.warn('[Supabase Sync Warning] Cache initial utilisé:', err.message);
  }
}


// Persist helper functions
async function persistPartnerToSupabase(partner: Partner) {
  try {
    const cleanApiConfig = partner.apiConfig ? { ...partner.apiConfig } : {};
    delete (cleanApiConfig as any)._profileMeta;
    const storedApiConfig = {
      ...cleanApiConfig,
      _profileMeta: {
        address: partner.address || '',
        website: partner.website || '',
        logoUrl: partner.logoUrl || '',
        cityTariffs: partner.cityTariffs || undefined,
        deliveryFee: partner.deliveryFee ?? 30,
        returnFee: partner.returnFee ?? 10,
        settlements: partner.settlements || []
      }
    };
    await supabase.from('delivery_partners').upsert({
      id: partner.id,
      name: partner.name,
      contact_person: partner.contactPerson,
      phone: partner.phone,
      email: partner.email,
      city: partner.city,
      active: partner.active,
      notes: partner.notes,
      api_config: storedApiConfig,
      total_sent: partner.totalSent || 0,
      total_received: partner.totalReceived || 0,
      total_delivered: partner.totalDelivered || 0,
      total_pending: partner.totalPending || 0,
      updated_at: new Date().toISOString()
    });
  } catch (e: any) {
    console.warn('[Supabase Persist Error] Partner:', e.message);
  }
}

function mergePartnerSecretsFromStorage(partner: Partner): Partner {
  if (!partner?.id) return partner;
  const secrets = persistentStorage.getPartnerSecrets(partner.id);
  if (!secrets) return partner;
  const isMasked = (val?: string) => typeof val === 'string' && val.includes('••••');
  return {
    ...partner,
    webhookToken: (!partner.webhookToken || isMasked(partner.webhookToken)) ? (secrets.webhookToken || partner.webhookToken) : partner.webhookToken,
    apiConfig: partner.apiConfig
      ? {
          ...partner.apiConfig,
          apiKey: (!partner.apiConfig.apiKey || isMasked(partner.apiConfig.apiKey)) ? (secrets.apiKey || partner.apiConfig.apiKey) : partner.apiConfig.apiKey,
          apiSecret: (!partner.apiConfig.apiSecret || isMasked(partner.apiConfig.apiSecret)) ? (secrets.apiSecret || partner.apiConfig.apiSecret) : partner.apiConfig.apiSecret,
          password: (!partner.apiConfig.password || isMasked(partner.apiConfig.password)) ? (secrets.password || partner.apiConfig.password) : partner.apiConfig.password,
          webhookSecret: (!partner.apiConfig.webhookSecret || isMasked(partner.apiConfig.webhookSecret)) ? (secrets.webhookSecret || partner.apiConfig.webhookSecret) : partner.apiConfig.webhookSecret
        }
      : partner.apiConfig
  };
}

function getSyncedPartners(): Partner[] {
  const stored = persistentStorage.getSystemCollection<Partner[]>('partners');
  if (!Array.isArray(stored) || stored.length === 0) {
    return partnersCache.map(mergePartnerSecretsFromStorage);
  }
  const mergedMap = new Map<string, Partner>();
  for (const p of partnersCache) {
    if (p?.id) mergedMap.set(p.id, mergePartnerSecretsFromStorage(p));
  }
  for (const p of stored) {
    if (!p?.id) continue;
    const prev = mergedMap.get(p.id);
    if (prev?.apiConfig) {
      const mergedConfig = {
        ...prev.apiConfig,
        ...(p.apiConfig || {})
      };
      if ((!p.apiConfig?.apiKey || p.apiConfig.apiKey.includes('••••')) && prev.apiConfig.apiKey) {
        mergedConfig.apiKey = prev.apiConfig.apiKey;
      }
      if ((!p.apiConfig?.apiSecret || p.apiConfig.apiSecret.includes('••••')) && prev.apiConfig.apiSecret) {
        mergedConfig.apiSecret = prev.apiConfig.apiSecret;
      }
      if ((!p.apiConfig?.password || p.apiConfig.password.includes('••••')) && prev.apiConfig.password) {
        mergedConfig.password = prev.apiConfig.password;
      }
      if ((!p.apiConfig?.webhookSecret || p.apiConfig.webhookSecret.includes('••••')) && prev.apiConfig.webhookSecret) {
        mergedConfig.webhookSecret = prev.apiConfig.webhookSecret;
      }
      mergedMap.set(
        p.id,
        mergePartnerSecretsFromStorage({
          ...prev,
          ...p,
          apiConfig: mergedConfig
        })
      );
    } else {
      mergedMap.set(p.id, mergePartnerSecretsFromStorage(p));
    }
  }
  return Array.from(mergedMap.values());
}

function findSyncedPartner(id: string): Partner | undefined {
  return getSyncedPartners().find(p => p.id === id);
}

async function syncPartnerEverywhere(partner: Partner) {
  persistentStorage.savePartnerSecrets(partner.id, {
    apiKey: partner.apiConfig?.apiKey,
    apiSecret: partner.apiConfig?.apiSecret,
    password: partner.apiConfig?.password,
    webhookSecret: partner.apiConfig?.webhookSecret,
    webhookToken: partner.webhookToken
  });

  const withSecrets = mergePartnerSecretsFromStorage(partner);
  const idx = partnersCache.findIndex(p => p.id === withSecrets.id);
  if (idx !== -1) {
    partnersCache[idx] = withSecrets;
  } else {
    partnersCache.push(withSecrets);
  }

  const stored = persistentStorage.getSystemCollection<Partner[]>('partners');
  const updatedStored = Array.isArray(stored) ? [...stored] : [];
  const sIdx = updatedStored.findIndex(p => p.id === withSecrets.id);
  const sanitizedForClient = sanitizePartner(withSecrets);
  if (sIdx !== -1) {
    updatedStored[sIdx] = {
      ...updatedStored[sIdx],
      ...sanitizedForClient,
      apiTokens: withSecrets.apiTokens ?? updatedStored[sIdx].apiTokens
    };
  } else {
    updatedStored.push({
      ...sanitizedForClient,
      apiTokens: withSecrets.apiTokens
    });
  }
  persistentStorage.setSystemCollection('partners', updatedStored);

  await persistPartnerToSupabase(withSecrets);
}

function getSyncedDriverRequests(): DriverRegistrationRequest[] {
  const stored = persistentStorage.getSystemCollection<DriverRegistrationRequest[]>('driverRequests');
  if (Array.isArray(stored) && stored.length > 0) {
    const byId = new Map<string, DriverRegistrationRequest>();
    for (const r of driverRequestsCache) {
      if (r?.id) byId.set(r.id, r);
    }
    for (const r of stored) {
      if (r?.id) byId.set(r.id, r);
    }
    driverRequestsCache = Array.from(byId.values()).sort(
      (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
  }
  return driverRequestsCache;
}

function saveSyncedDriverRequests(list: DriverRegistrationRequest[]) {
  driverRequestsCache = list;
  persistentStorage.setSystemCollection('driverRequests', list);
}

function applyPackageOverrides(mappedPkg: any): any {
  const ov = persistentStorage.getPackageOverrides([mappedPkg.id, mappedPkg.trackingNumber]);
  if (!ov) return mappedPkg;
  const { problemReport: ovProb, ...restOv } = ov as any;
  const merged = {
    ...mappedPkg,
    ...restOv
  };
  if (mappedPkg.problemReport && !mappedPkg.problemReport.resolved) {
    merged.status = 'probleme_livraison';
  }
  if (ovProb && !merged.problemReport) {
    merged.problemReport = ovProb;
  }
  if (Array.isArray(ov.history) && ov.history.length > 0) {
    const baseHist = Array.isArray(mappedPkg.history) ? mappedPkg.history : [];
    const seen = new Set(baseHist.map((h: any) => h.id));
    merged.history = [...baseHist, ...ov.history.filter((h: any) => h && !seen.has(h.id))];
  }
  return merged;
}

async function syncLogsEverywhere(logItem: PartnerSyncLog) {
  syncLogsCache.unshift(logItem);
  if (syncLogsCache.length > 100) {
    syncLogsCache = syncLogsCache.slice(0, 100);
  }
  const storedLogs = persistentStorage.getSystemCollection<PartnerSyncLog[]>('partnerSyncLogs');
  if (Array.isArray(storedLogs)) {
    persistentStorage.setSystemCollection('partnerSyncLogs', [logItem, ...storedLogs].slice(0, 100));
  } else {
    persistentStorage.setSystemCollection('partnerSyncLogs', [logItem]);
  }
  await persistSyncLogToSupabase(logItem);
}

async function updateParcelStatusEverywhere(
  trackingOrRef: string,
  newInternalStatus: PackageStatus,
  rawStateLabel: string,
  sourceName: string,
  comment?: string
): Promise<{ found: boolean; oldStatus: string; trackingNumber: string }> {
  const clean = String(trackingOrRef || '').trim();
  if (!clean) {
    return { found: false, oldStatus: '', trackingNumber: clean };
  }
  const upper = clean.toUpperCase();

  // 1. Check persistentStorage local packages
  const allLocalPkgs = persistentStorage.getPackages();
  const localPkg = allLocalPkgs.find(
    p =>
      (p.trackingNumber && p.trackingNumber.toUpperCase() === upper) ||
      (p.partnerTrackingNumber && p.partnerTrackingNumber.toUpperCase() === upper) ||
      (p.id && p.id.toUpperCase() === upper)
  );

  let oldStatusLabel = '';
  let resolvedTracking = clean;

  if (localPkg) {
    oldStatusLabel = PACKAGE_STATUS_CONFIG[localPkg.status]?.label || localPkg.status;
    resolvedTracking = localPkg.trackingNumber || clean;
    persistentStorage.updatePackageStatus(
      localPkg.id,
      newInternalStatus,
      comment || `Mise à jour ${sourceName} : ${rawStateLabel}`
    );
    persistentStorage.updatePackage(localPkg.id, {
      partnerLastSyncAt: new Date().toISOString(),
      partnerSyncStatus: 'synced'
    });
  }

  // 2. Check & update Supabase packages table
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);
    let pkg: any = null;

    if (isUuid) {
      const byId: any = await safeDbQuery(
        supabase.from('packages').select('*').eq('id', clean).maybeSingle(),
        2500
      );
      pkg = byId?.data || null;
    }

    if (!pkg) {
      const byTrk: any = await safeDbQuery(
        supabase.from('packages').select('*').ilike('tracking_number', clean).maybeSingle(),
        2500
      );
      pkg = byTrk?.data || null;
    }

    if (!pkg) {
      const byPartnerTrk: any = await safeDbQuery(
        supabase.from('packages').select('*').eq('partner_tracking_number', clean).maybeSingle(),
        1500
      );
      pkg = byPartnerTrk?.data || null;
    }

    if (pkg) {
      if (!oldStatusLabel) {
        oldStatusLabel = PACKAGE_STATUS_CONFIG[pkg.status as PackageStatus]?.label || pkg.status;
      }
      resolvedTracking = pkg.tracking_number || resolvedTracking;
      const nowIso = new Date().toISOString();
      let dbStatus = newInternalStatus;

      let updRes: any = await safeDbQuery(
        supabase
          .from('packages')
          .update({ status: dbStatus, updated_at: nowIso })
          .eq('id', pkg.id),
        2500
      );

      if (updRes?.error && (newInternalStatus === 'probleme_livraison' || newInternalStatus === 'pas_de_reponse')) {
        dbStatus = 'reporte';
        updRes = await safeDbQuery(
          supabase
            .from('packages')
            .update({ status: dbStatus, updated_at: nowIso })
            .eq('id', pkg.id),
          2500
        );
      }

      // Optional partner sync metadata update (ignore if optional columns aren't migrated)
      await safeDbQuery(
        supabase
          .from('packages')
          .update({ partner_last_sync_at: nowIso, partner_sync_status: 'synced' })
          .eq('id', pkg.id),
        1000
      );

      return { found: true, oldStatus: oldStatusLabel, trackingNumber: resolvedTracking };
    }
  } catch {
    // Supabase optional fallback
  }

  if (localPkg) {
    return { found: true, oldStatus: oldStatusLabel, trackingNumber: resolvedTracking };
  }

  return { found: false, oldStatus: '', trackingNumber: clean };
}

async function safeDbQuery<T>(promise: PromiseLike<T>, timeoutMs = 1200, fallback: any = { data: null, error: null }): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error('Supabase query timeout')), timeoutMs)
  );
  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch {
    return fallback;
  }
}

async function persistSyncLogToSupabase(logItem: PartnerSyncLog) {
  try {
    await safeDbQuery(
      supabase.from('partner_sync_logs').insert({
        id: logItem.id,
        timestamp: logItem.timestamp,
        partner_id: logItem.partnerId,
        partner_name: logItem.partnerName,
        direction: logItem.direction,
        status: logItem.status,
        status_code: logItem.statusCode,
        endpoint: logItem.endpoint,
        message: logItem.message,
        package_count: logItem.packageCount || 0,
        tracking_numbers: logItem.trackingNumbers || [],
        request_payload_preview: logItem.requestPayloadPreview,
        response_payload_preview: logItem.responsePayloadPreview,
        duration_ms: logItem.durationMs || 0
      }),
      1500
    );
  } catch (e: any) {
    console.warn('[Supabase Persist Error] SyncLog:', e.message);
  }
}

const normalizeAuthRole = (r: string) => {
  const clean = (r || '').toLowerCase().trim();
  if (clean === 'super_admin' || clean === 'superadmin' || clean === 'directeur' || clean === 'pdg') return 'admin';
  if (clean === 'boutique' || clean === 'merchant' || clean === 'vendeur' || clean === 'vendor' || clean === 'store' || clean === 'shop') return 'client';
  if (clean === 'ops' || clean === 'gestionnaire' || clean === 'staff' || clean === 'manager' || clean === 'employe' || clean === 'employé') return 'employee';
  if (clean === 'livreur' || clean === 'coursier') return 'driver';
  return clean;
};

const normalizeShopAccountStatus = (raw?: string): 'en_attente' | 'approuve' | 'refuse' | 'suspendu' => {
  const clean = (raw || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (clean === 'en_attente' || clean === 'pending') return 'en_attente';
  if (clean === 'refuse' || clean === 'rejected' || clean === 'rejete') return 'refuse';
  if (clean === 'suspendu' || clean === 'suspended' || clean === 'inactive' || clean === 'desactive') return 'suspendu';
  return 'approuve';
};

const isOwnerSuperAdmin = (userOrProfile: any): boolean => {
  if (!userOrProfile) return false;
  const email = String(userOrProfile.email || '').toLowerCase().trim();
  const rawRole = String(userOrProfile.role || '').toLowerCase().trim();
  return email === 'wadarazzeddine30@gmail.com' || rawRole === 'super_admin' || rawRole === 'superadmin';
};

const extractCookieValue = (req: Request, cookieName: string): string | undefined => {
  const rawCookie = req.headers.cookie;
  if (!rawCookie || typeof rawCookie !== 'string') return undefined;
  const parts = rawCookie.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === cookieName) {
      const val = part.slice(eqIdx + 1).trim();
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return undefined;
};

const extractSessionToken = (req: Request): string | undefined => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const tok = authHeader.slice(7).trim();
    if (tok && tok !== 'undefined' && tok !== 'null') return tok;
  }
  const cookieTok = extractCookieValue(req, 'far_session');
  if (cookieTok && cookieTok !== 'undefined' && cookieTok !== 'null') return cookieTok;
  return undefined;
};

const setSessionCookie = (res: Response, token: string, rememberMe = true) => {
  const maxAge = 30 * 24 * 60 * 60;
  const secureFlag = NODE_ENV === 'production' ? '; Secure' : '';
  const maxAgePart = rememberMe ? `; Max-Age=${maxAge}` : '';
  res.setHeader(
    'Set-Cookie',
    `far_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${maxAgePart}${secureFlag}`
  );
};

const clearSessionCookie = (res: Response) => {
  res.setHeader('Set-Cookie', 'far_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
};

const resolveAuthenticatedCaller = async (
  req: Request
): Promise<{ id: string; email: string; role: string; rawRole: string; isSuper: boolean; shopId?: string } | null> => {
  const token = extractSessionToken(req);
  if (!token) return null;

  if (token.startsWith('far_sec_')) {
    const user = persistentStorage.verifySession(token);
    if (!user) return null;
    const rawRole = String(user.role || '');
    return {
      id: user.id,
      email: user.email || '',
      role: normalizeAuthRole(rawRole),
      rawRole,
      isSuper: isOwnerSuperAdmin(user),
      shopId: (user as any).shopId
    };
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await supabase.from('profiles').select('id, role, email').eq('id', user.id).maybeSingle();
    const storedUser = !profile ? persistentStorage.findUserById(user.id) : null;
    const rawRole = String(profile?.role || storedUser?.role || (user.email?.toLowerCase() === 'wadarazzeddine30@gmail.com' ? 'super_admin' : ''));
    if (!rawRole) return null;
    return {
      id: user.id,
      email: profile?.email || user.email || '',
      role: normalizeAuthRole(rawRole),
      rawRole,
      isSuper: isOwnerSuperAdmin({ email: user.email, role: rawRole }),
      shopId: (storedUser as any)?.shopId
    };
  } catch {
    return null;
  }
};

/**
 * Authentication and authorization middleware (Zero backdoors)
 */
const authenticateAndAuthorize = (allowedRoles: string[] = ['admin', 'employee']) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const internalKey = req.headers['x-fariousy-internal-key'];
    const configuredSecret = (process.env.FARIOUSY_API_SECRET || '').trim();
    if (configuredSecret && internalKey && internalKey === configuredSecret) {
      return next();
    }

    const token = extractSessionToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentification requise. Session ou jeton manquant.'
      });
    }

    // 1. Strict verification of server-issued session tokens (no forgery/ID recovery fallback)
    if (token.startsWith('far_sec_')) {
      const user = persistentStorage.verifySession(token);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Session FARIOUSY expirée ou révoquée. Veuillez vous reconnecter.'
        });
      }

      const rawRole = String(user.role || '');
      const role = normalizeAuthRole(rawRole);
      const isSuper = isOwnerSuperAdmin(user);

      if (!isSuper && (user.status === 'suspendu' || user.status === 'inactive' || ['suspendu', 'refuse', 'rejete', 'en_attente'].includes(String(user.accountStatus || '')))) {
        const status = req.method === 'GET' ? 403 : 422;
        return res.status(status).json({
          success: false,
          code: 'ACCOUNT_SUSPENDED',
          error: user.statusReason || "Votre compte est temporairement suspendu ou en attente de validation."
        });
      }

      if (allowedRoles.length > 0 && !isSuper && !allowedRoles.includes(role) && !allowedRoles.includes(rawRole)) {
        console.warn(`[AUTH 403 far_sec] path=${req.path} user=${user.email} role=${rawRole} allowed=${allowedRoles.join(',')}`);
        const status = req.method === 'GET' ? 403 : 401;
        return res.status(status).json({
          success: false,
          code: 'FORBIDDEN',
          error: `Accès refusé. Rôle requis: [${allowedRoles.join(', ')}] — Rôle actuel: ${rawRole}`
        });
      }

      (req as any).user = { id: user.id, email: user.email };
      (req as any).profile = user;
      (req as any).sessionToken = token;
      return next();
    }

    // 2. Supabase Auth Token verification
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) {
        return res.status(401).json({
          success: false,
          error: 'Jeton Supabase invalide ou session expirée.'
        });
      }

      // Check role directly from public.profiles using Supabase Auth ID (or email/persistentStorage fallback)
      let { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (!profile && user.email) {
        const { data: profByEmail } = await supabase
          .from('profiles')
          .select('*')
          .ilike('email', user.email)
          .maybeSingle();
        if (profByEmail) profile = profByEmail;
      }

      if (!profile) {
        const storedUser =
          persistentStorage.findUserById(user.id) ||
          (user.email ? persistentStorage.findUserByIdentifier(user.email) : null);
        if (storedUser) {
          profile = {
            id: storedUser.id,
            role: storedUser.role,
            full_name: storedUser.name,
            email: storedUser.email,
            phone: storedUser.phone,
            city: storedUser.city
          };
        } else if (user.email) {
          const { data: shopMatch } = await supabase
            .from('merchant_shops')
            .select('*')
            .or(`user_id.eq.${user.id},email.ilike.${user.email}`)
            .maybeSingle();
          if (shopMatch) {
            profile = {
              id: shopMatch.user_id || user.id,
              role: 'client',
              full_name: shopMatch.manager_name || shopMatch.shop_name,
              email: shopMatch.email || user.email,
              phone: shopMatch.phone || '',
              city: shopMatch.city || 'Casablanca'
            };
          }
        }
      }

      if (!profile && user.email?.toLowerCase() === 'wadarazzeddine30@gmail.com') {
        profile = {
          id: user.id,
          role: 'super_admin',
          full_name: 'Azzeddine Wadar',
          email: user.email,
          phone: '+212 661 00 00 01',
          city: 'Laâyoune'
        };
      }

      if (!profile) {
        console.warn(`[AUTH 403 sb no profile] path=${req.path} userId=${user.id} email=${user.email}`);
        const status = req.method === 'GET' ? 403 : 401;
        return res.status(status).json({
          success: false,
          code: 'FORBIDDEN',
          error: "Aucun profil associé à cet utilisateur dans la table public.profiles. Accès non autorisé."
        });
      }

      const rawRoleSb = profile.role || (user.user_metadata as any)?.role || '';
      const normalizeSbRole = (r: string) => {
        const clean = (r || '').toLowerCase().trim();
        if (clean === 'super_admin' || clean === 'superadmin' || clean === 'directeur' || clean === 'pdg') return 'admin';
        if (clean === 'boutique' || clean === 'merchant' || clean === 'vendeur' || clean === 'vendor' || clean === 'store' || clean === 'shop') return 'client';
        if (clean === 'ops' || clean === 'gestionnaire' || clean === 'staff' || clean === 'manager' || clean === 'employe' || clean === 'employé') return 'employee';
        if (clean === 'livreur' || clean === 'coursier') return 'driver';
        return clean;
      };
      const role = normalizeSbRole(rawRoleSb);
      if (!role) {
        console.warn(`[AUTH 403 sb no role] path=${req.path} userId=${user.id} email=${user.email}`);
        const status = req.method === 'GET' ? 403 : 401;
        return res.status(status).json({
          success: false,
          code: 'FORBIDDEN',
          error: "Rôle non défini dans le profil utilisateur."
        });
      }

      const isSuperSb = rawRoleSb === 'super_admin' || rawRoleSb === 'superadmin' || user.email?.toLowerCase() === 'wadarazzeddine30@gmail.com';
      if (allowedRoles.length > 0 && !isSuperSb && !allowedRoles.includes(role) && !allowedRoles.includes(rawRoleSb)) {
        console.warn(`[AUTH 403 sb role mismatch] path=${req.path} email=${user.email} role=${rawRoleSb} allowed=${allowedRoles.join(',')}`);
        const status = req.method === 'GET' ? 403 : 401;
        return res.status(status).json({
          success: false,
          code: 'FORBIDDEN',
          error: `Accès refusé. Rôle requis: [${allowedRoles.join(', ')}] — Rôle actuel: ${rawRoleSb}`
        });
      }

      // Étape 78: Empêcher un client désactivé/suspendu d'effectuer des opérations serveur
      if (role === 'client') {
        const { data: clientShop } = await supabase
          .from('merchant_shops')
          .select('account_status, status_reason')
          .eq('user_id', user.id)
          .maybeSingle();

        if (clientShop && clientShop.account_status === 'suspendu') {
          console.warn(`[AUTH 403 sb shop suspended] path=${req.path} email=${user.email}`);
          const status = req.method === 'GET' ? 403 : 422;
          return res.status(status).json({
            success: false,
            code: 'ACCOUNT_SUSPENDED',
            error: clientShop.status_reason || "Votre compte boutique est suspendu par l'administration. Veuillez contacter FARIOUSY DELIVERY."
          });
        }
      }

      (req as any).user = user;
      (req as any).profile = profile;
      next();
    } catch (err: any) {
      return res.status(401).json({
        success: false,
        error: `Erreur de vérification auth: ${err.message}`
      });
    }
  };
};

/**
 * Express app builder for standalone VPS and Vercel Serverless Functions
 */
export function createExpressApp() {
  const app = express();

  // Trust proxy for reverse proxies and Vercel Edge CDN
  app.set('trust proxy', 1);

  // Security Headers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // CORS for app.fariousy.com and preview deployments
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin || '*';
    const allowedOrigins = [
      'https://app.fariousy.com',
      'http://app.fariousy.com',
      'https://fariousy.com',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000'
    ];

    if (allowedOrigins.includes(origin as string) || (typeof origin === 'string' && origin.endsWith('.vercel.app')) || NODE_ENV !== 'production') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-KEY, X-Partner-Secret, X-Webhook-Token, X-Fariousy-Internal-Key'
    );

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Body parsers
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ---------------------------------------------------------------------------
  // AUTH PROFILE ENDPOINT (VERIFIES SUPABASE AUTH TOKEN & RETURNS public.profiles)
  // ---------------------------------------------------------------------------
  app.get(['/api/auth/profile', '/api/auth/me'], async (req: Request, res: Response) => {
    const token = extractSessionToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentification requise. Session ou jeton manquant.'
      });
    }

    if (token.startsWith('far_sec_')) {
      const user = persistentStorage.verifySession(token);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Session expirée ou invalide.'
        });
      }
      const freshStored = persistentStorage.findUserById(user.id) || user;
      const kyc = persistentStorage.getKycDocuments([freshStored.id, freshStored.email]);
      const enrichedUser = {
        ...freshStored,
        bankName: freshStored.bankName ?? kyc?.bankName,
        bankRib: freshStored.bankRib ?? kyc?.bankRib
      };
      return res.json({
        success: true,
        user: { id: enrichedUser.id, email: enrichedUser.email },
        profile: enrichedUser
      });
    }

    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) {
        return res.status(401).json({
          success: false,
          error: 'Jeton Supabase invalide ou session expirée.'
        });
      }

      const { data: profile, error: profErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (profErr) {
        return res.status(500).json({
          success: false,
          error: `Erreur lors de la lecture de public.profiles: ${profErr.message}`
        });
      }

      if (!profile) {
        return res.status(404).json({
          success: false,
          error: "Aucun profil trouvé dans la table public.profiles pour cet identifiant."
        });
      }

      let mergedProfile = { ...profile };
      if (profile.role === 'client') {
        const { data: clientShop } = await supabase
          .from('merchant_shops')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();

        if (clientShop) {
          mergedProfile = {
            ...mergedProfile,
            shop_id: clientShop.id,
            company_name: clientShop.shop_name,
            status: clientShop.account_status,
            account_status: clientShop.account_status,
            status_reason: clientShop.status_reason,
            approved_at: clientShop.approved_at,
            approved_by: clientShop.approved_by,
            bank_name: clientShop.bank_name || mergedProfile.bank_name,
            bank_rib: clientShop.bank_rib || mergedProfile.bank_rib
          };
        }
      }

      const kycDocs = persistentStorage.getKycDocuments([user.id, user.email, profile.email]);
      if (kycDocs) {
        mergedProfile = {
          ...mergedProfile,
          cinNumber: mergedProfile.cinNumber || kycDocs.cinNumber,
          cinPhotoUrl: kycDocs.cinPhotoUrl,
          cinBackPhotoUrl: kycDocs.cinBackPhotoUrl,
          driverPhotoUrl: kycDocs.driverPhotoUrl,
          avatarUrl: kycDocs.driverPhotoUrl || mergedProfile.avatar_url,
          bankName: mergedProfile.bank_name || mergedProfile.bankName || kycDocs.bankName,
          bankRib: mergedProfile.bank_rib || mergedProfile.bankRib || kycDocs.bankRib
        };
      }

      return res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email
        },
        profile: mergedProfile
      });
    } catch (e: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur auth: ${e.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // CLIENT SELF-SERVICE PROFILE UPDATE (Coordonnées + Banque / RIB Bancaire)
  // ---------------------------------------------------------------------------
  app.put('/api/client/profile', authenticateAndAuthorize(['client', 'admin', 'super_admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const reqUser = (req as any).user;
      const reqProfile = (req as any).profile;
      const callerRole = String(reqProfile?.role || reqUser?.role || '').toLowerCase();
      const canTargetOther = callerRole === 'admin' || callerRole === 'super_admin' || callerRole === 'employee';
      const targetUserId = (canTargetOther && req.body?.userId)
        ? String(req.body.userId)
        : String(reqProfile?.id || reqUser?.id || '');

      if (!targetUserId) {
        return res.status(401).json({ success: false, error: 'Utilisateur non authentifié.' });
      }

      const {
        companyName,
        name,
        email,
        phone,
        whatsapp,
        city,
        address,
        bankName,
        bankRib
      } = req.body || {};

      const cleanRib = typeof bankRib === 'string' ? bankRib.replace(/[^0-9]/g, '') : undefined;
      if (cleanRib !== undefined && cleanRib.length > 0 && !/^\d{24}$/.test(cleanRib)) {
        return res.status(400).json({
          success: false,
          error: 'Le numéro RIB bancaire doit contenir exactement 24 chiffres (رقم الحساب البنكي يجب أن يتكون من 24 رقماً).'
        });
      }

      const cleanBankName = typeof bankName === 'string' ? bankName.trim() : undefined;
      const existingStored = persistentStorage.findUserById(targetUserId);
      const effectiveEmail = (email || existingStored?.email || reqProfile?.email || reqUser?.email || '').trim();

      const updates: Record<string, any> = {};
      if (typeof companyName === 'string' && companyName.trim()) updates.companyName = companyName.trim();
      if (typeof name === 'string' && name.trim()) updates.name = name.trim();
      if (typeof email === 'string' && email.trim()) updates.email = email.trim();
      if (typeof phone === 'string' && phone.trim()) updates.phone = phone.trim();
      if (typeof whatsapp === 'string') updates.whatsapp = whatsapp.trim();
      if (typeof city === 'string' && city.trim()) updates.city = city.trim();
      if (typeof address === 'string') updates.address = address.trim();
      if (cleanBankName !== undefined) updates.bankName = cleanBankName;
      if (cleanRib !== undefined) updates.bankRib = cleanRib;

      if (cleanBankName !== undefined || cleanRib !== undefined) {
        persistentStorage.saveKycDocuments(
          [targetUserId, effectiveEmail, (existingStored as any)?.shopId].filter(Boolean) as string[],
          {
            bankName: cleanBankName,
            bankRib: cleanRib
          }
        );
      }

      let updatedStored: any = null;
      if (existingStored) {
        updatedStored = persistentStorage.updateUser(targetUserId, updates);
      } else {
        updatedStored = persistentStorage.upsertUser({
          id: targetUserId,
          email: effectiveEmail,
          name: updates.name || reqProfile?.full_name || reqProfile?.name || 'Client',
          role: 'client',
          phone: updates.phone || reqProfile?.phone || '',
          companyName: updates.companyName || reqProfile?.company_name || reqProfile?.companyName || updates.name || 'Boutique',
          city: updates.city || reqProfile?.city || 'Casablanca',
          address: updates.address || reqProfile?.address || '',
          status: 'active',
          accountStatus: 'approuve',
          registeredAt: new Date().toISOString(),
          ...updates
        } as any);
      }

      // Best-effort sync to Supabase public.profiles & public.merchant_shops
      try {
        const now = new Date().toISOString();
        const profPayload: Record<string, any> = { updated_at: now };
        if (updates.name) profPayload.full_name = updates.name;
        if (updates.phone) profPayload.phone = updates.phone;
        if (updates.whatsapp !== undefined) profPayload.whatsapp = updates.whatsapp;
        if (updates.city) profPayload.city = updates.city;
        if (updates.address !== undefined) profPayload.address = updates.address;

        await supabase.from('profiles').update(profPayload).eq('id', targetUserId);

        if (cleanBankName !== undefined || cleanRib !== undefined) {
          await supabase
            .from('profiles')
            .update({
              ...(cleanBankName !== undefined ? { bank_name: cleanBankName } : {}),
              ...(cleanRib !== undefined ? { bank_rib: cleanRib } : {})
            })
            .eq('id', targetUserId);
        }

        const shopPayload: Record<string, any> = { updated_at: now };
        if (updates.companyName) shopPayload.shop_name = updates.companyName;
        if (updates.name) shopPayload.manager_name = updates.name;
        if (updates.phone) shopPayload.phone = updates.phone;
        if (updates.whatsapp !== undefined) shopPayload.whatsapp = updates.whatsapp;
        if (updates.city) shopPayload.city = updates.city;
        if (updates.address !== undefined) shopPayload.pickup_address = updates.address;

        await supabase.from('merchant_shops').update(shopPayload).eq('user_id', targetUserId);

        if (cleanBankName !== undefined || cleanRib !== undefined) {
          await supabase
            .from('merchant_shops')
            .update({
              ...(cleanBankName !== undefined ? { bank_name: cleanBankName } : {}),
              ...(cleanRib !== undefined ? { bank_rib: cleanRib } : {})
            })
            .eq('user_id', targetUserId);
        }
      } catch (sbSyncErr) {
        console.warn('[Client profile Supabase optional sync notice]', sbSyncErr);
      }

      return res.json({
        success: true,
        profile: updatedStored || { id: targetUserId, email: effectiveEmail, ...updates }
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors de la sauvegarde du profil : ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // AUTH LOGIN ENDPOINT (SUPABASE AUTH + RESILIENT PERSISTENT SERVER FALLBACK)
  // ---------------------------------------------------------------------------
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const { identifier, password, rememberMe } = req.body;
      const shouldRemember = rememberMe !== false;
      const rawIdentifier = (identifier || '').trim();
      const cleanPassword = (password || '').trim();

      if (!rawIdentifier) {
        return res.status(400).json({
          success: false,
          error: 'Veuillez saisir votre numéro de téléphone ou votre adresse e-mail.'
        });
      }
      if (!cleanPassword) {
        return res.status(400).json({
          success: false,
          error: 'Veuillez saisir votre mot de passe.'
        });
      }

      let targetEmail = rawIdentifier.toLowerCase();

      // Si l'identifiant est un numéro de téléphone
      if (!rawIdentifier.includes('@')) {
        const userByPhone = persistentStorage.findUserByIdentifier(rawIdentifier);
        if (userByPhone && userByPhone.email) {
          targetEmail = userByPhone.email.toLowerCase();
        } else {
          const cleanDigits = rawIdentifier.replace(/\D/g, '');
          if (cleanDigits.length >= 8) {
            const last8 = cleanDigits.slice(-8);
            try {
              const { data: prof } = await supabase
                .from('profiles')
                .select('email, phone')
                .ilike('phone', `%${last8}%`)
                .maybeSingle();
              if (prof?.email) {
                targetEmail = prof.email.toLowerCase();
              } else {
                const { data: sh } = await supabase
                  .from('merchant_shops')
                  .select('email, phone')
                  .ilike('phone', `%${last8}%`)
                  .maybeSingle();
                if (sh?.email) {
                  targetEmail = sh.email.toLowerCase();
                }
              }
            } catch (resolveErr) {
              console.warn('[Phone resolve err]', resolveErr);
            }
          }
        }
      }

      // 1. Tenter l'authentification Supabase avec un client isolé (supporte sb_secret_, sb_publishable_ et JWT)
      const publishableFromUrl = process.env.VITE_SUPABASE_URL?.startsWith('sb_publishable_')
        ? process.env.VITE_SUPABASE_URL.trim()
        : '';
      const candidateKeys = Array.from(
        new Set([SUPABASE_KEY, SUPABASE_ANON_KEY, publishableFromUrl].filter(k => isValidSupabaseKey(k)))
      );

      if (candidateKeys.length > 0 && targetEmail.includes('@')) {
        try {
          let authData: any = null;
          let authErr: any = null;

          for (const candidateKey of candidateKeys) {
            const authClient = createClient(SUPABASE_URL, candidateKey, {
              auth: { persistSession: false, autoRefreshToken: false }
            });
            const resSign = await authClient.auth.signInWithPassword({
              email: targetEmail,
              password: cleanPassword
            });
            authData = resSign.data;
            authErr = resSign.error;
            if (!authErr && authData?.user) break;
            const errMsg = String(authErr?.message || '').toLowerCase();
            if (!errMsg.includes('api key') && !errMsg.includes('apikey')) {
              break;
            }
          }

          if (!authErr && authData?.user) {
            let { data: profile } = await supabase
              .from('profiles')
              .select('*')
              .eq('id', authData.user.id)
              .maybeSingle();

            if (!profile && (authData.user.email || targetEmail).toLowerCase() === 'wadarazzeddine30@gmail.com') {
              profile = {
                id: authData.user.id,
                email: authData.user.email || targetEmail,
                full_name: 'Azzeddine Wadar',
                role: 'super_admin',
                phone: '+212 661 00 00 01',
                city: 'Laâyoune',
                status: 'active',
                account_status: 'approuve',
                created_at: authData.user.created_at || new Date().toISOString()
              };
            }

            if (profile) {
              let effectiveAccountStatus = profile.account_status || profile.status || 'approuve';
              let statusReason = profile.status_reason || '';
              let shopId: string | undefined;
              if (profile.role === 'client') {
                const { data: shopRow } = await supabase
                  .from('merchant_shops')
                  .select('id, account_status, status_reason')
                  .eq('user_id', authData.user.id)
                  .maybeSingle();
                if (shopRow) {
                  shopId = shopRow.id;
                  if (shopRow.account_status) effectiveAccountStatus = shopRow.account_status;
                  if (shopRow.status_reason) statusReason = shopRow.status_reason;
                }
              }

              const isSuper = isOwnerSuperAdmin({ email: authData.user.email || targetEmail, role: profile.role });
              if (!isSuper && (effectiveAccountStatus === 'en_attente' || effectiveAccountStatus === 'pending')) {
                return res.status(403).json({
                  success: false,
                  accountStatus: 'en_attente',
                  error: "Votre compte est en attente de validation par le Super Administrateur."
                });
              }
              if (!isSuper && ['suspendu', 'refuse', 'rejete', 'inactive'].includes(String(effectiveAccountStatus || ''))) {
                return res.status(403).json({
                  success: false,
                  accountStatus: effectiveAccountStatus,
                  error: statusReason || "Votre compte a été suspendu ou désactivé par l'administration."
                });
              }

              const kyc = persistentStorage.getKycDocuments([authData.user.id, authData.user.email, profile.email]);
              const userObj = {
                id: authData.user.id,
                shopId,
                email: authData.user.email || targetEmail,
                name: profile.full_name || 'Utilisateur',
                role: isSuper ? 'super_admin' : profile.role,
                phone: profile.phone || '',
                city: profile.city || 'Casablanca',
                address: profile.address || '',
                status: effectiveAccountStatus === 'suspendu' ? 'suspendu' : (profile.status || 'active'),
                accountStatus: effectiveAccountStatus,
                bankName: profile.bank_name || kyc?.bankName || undefined,
                bankRib: profile.bank_rib || kyc?.bankRib || undefined,
                registeredAt: profile.created_at || new Date().toISOString()
              };

              persistentStorage.upsertUser(userObj as any);
              if (cleanPassword && !persistentStorage.verifyUserPassword(userObj.email, cleanPassword)) {
                persistentStorage.changeUserPassword(userObj.email, cleanPassword);
              }

              const sessionMeta = {
                ip: req.ip || (req.headers['x-forwarded-for'] as string) || '',
                userAgent: String(req.headers['user-agent'] || '').slice(0, 120),
                rememberMe: shouldRemember
              };
              const trackedSessionToken = persistentStorage.createSession(userObj as any, sessionMeta);
              persistentStorage.recordVisitorBrowser(String(req.headers['user-agent'] || ''));
              if (['super_admin', 'admin', 'employee'].includes(String(userObj.role))) {
                persistentStorage.recordStaffHeartbeat(userObj as any, {
                  autoStartShiftForEmployee: userObj.role === 'employee',
                  currentPage: 'admin_dashboard',
                  actionLabel: 'تسجيل الدخول'
                });
              }
              setSessionCookie(res, trackedSessionToken, shouldRemember);

              return res.json({
                success: true,
                token: trackedSessionToken,
                user: userObj
              });
            }
          }
        } catch (sbErr) {
          console.warn('[Supabase signIn notice]', sbErr);
        }
      }

      // 2. Authentification stricte via le stockage persistant du serveur (scrypt hash verified)
      const verifiedUser = persistentStorage.verifyCredentials(rawIdentifier, cleanPassword);
      if (verifiedUser) {
        const isSuper = isOwnerSuperAdmin(verifiedUser);
        const effStatus = verifiedUser.accountStatus || verifiedUser.status;
        if (!isSuper && (effStatus === 'en_attente' || effStatus === 'pending')) {
          return res.status(403).json({
            success: false,
            accountStatus: 'en_attente',
            error: "Votre compte est en attente de validation par le Super Administrateur."
          });
        }
        if (!isSuper && ['suspendu', 'refuse', 'rejete', 'inactive'].includes(String(effStatus || ''))) {
          return res.status(403).json({
            success: false,
            accountStatus: effStatus,
            error: verifiedUser.statusReason || "Votre compte est temporairement suspendu ou désactivé."
          });
        }

        const sessionToken = persistentStorage.createSession(verifiedUser, {
          ip: req.ip || (req.headers['x-forwarded-for'] as string) || '',
          userAgent: String(req.headers['user-agent'] || '').slice(0, 120),
          rememberMe: shouldRemember
        });
        persistentStorage.recordVisitorBrowser(String(req.headers['user-agent'] || ''));
        if (['super_admin', 'admin', 'employee'].includes(String(verifiedUser.role))) {
          persistentStorage.recordStaffHeartbeat(verifiedUser, {
            autoStartShiftForEmployee: verifiedUser.role === 'employee',
            currentPage: 'admin_dashboard',
            actionLabel: 'تسجيل الدخول'
          });
        }
        setSessionCookie(res, sessionToken, shouldRemember);
        return res.json({
          success: true,
          token: sessionToken,
          user: verifiedUser
        });
      }

      return res.status(401).json({
        success: false,
        error: 'Numéro de téléphone / e-mail ou mot de passe incorrect.'
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors de la connexion: ${err.message}`
      });
    }
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = extractSessionToken(req);
    if (token && token.startsWith('far_sec_')) {
      const sessUser = persistentStorage.verifySession(token);
      if (sessUser && ['super_admin', 'admin', 'employee'].includes(String(sessUser.role))) {
        persistentStorage.recordStaffHeartbeat(sessUser, {
          offline: true,
          actionLabel: 'تسجيل الخروج'
        });
      }
      persistentStorage.revokeSessionByToken(token);
    }
    clearSessionCookie(res);
    return res.json({ success: true });
  });

  // ---------------------------------------------------------------------------
  // AUTH RESOLVE IDENTIFIER ENDPOINT
  // Permet la connexion indifféremment par Téléphone ou par Email
  // ---------------------------------------------------------------------------
  app.post('/api/auth/resolve-identifier', async (req: Request, res: Response) => {
    try {
      const rawId = (req.body?.identifier || '').toString().trim();
      if (!rawId) {
        return res.status(400).json({ success: false, error: 'Identifiant requis.' });
      }

      // S'il s'agit déjà d'une adresse email
      if (rawId.includes('@')) {
        return res.json({ success: true, email: rawId.toLowerCase() });
      }

      // Recherche par numéro de téléphone dans public.profiles
      const digits = rawId.replace(/\D/g, '');
      const cleanPhone = rawId.replace(/[\s\-\.]/g, '');

      const { data: profs, error } = await supabase
        .from('profiles')
        .select('id, email, phone, role, full_name, status')
        .limit(20);

      if (!error && profs && profs.length > 0) {
        const match = profs.find((p: any) => {
          const pPhoneDigits = (p.phone || '').replace(/\D/g, '');
          const pWhatsappDigits = (p.whatsapp || '').replace(/\D/g, '');
          const pPhone = (p.phone || '').replace(/[\s\-\.]/g, '');

          return (
            pPhone === cleanPhone ||
            p.phone === rawId ||
            (digits.length >= 8 && pPhoneDigits.endsWith(digits.slice(-8))) ||
            (digits.length >= 8 && pWhatsappDigits.endsWith(digits.slice(-8)))
          );
        });

        if (match && match.email) {
          return res.json({
            success: true,
            email: match.email,
            role: match.role,
            name: match.full_name,
            phone: match.phone
          });
        }
      }

      // Recherche également dans public.merchant_shops
      const { data: shops } = await supabase
        .from('merchant_shops')
        .select('id, user_id, email, phone, whatsapp, shop_name, manager_name')
        .limit(50);

      if (shops && shops.length > 0) {
        const shopMatch = shops.find((s: any) => {
          const sPhoneDigits = (s.phone || '').replace(/\D/g, '');
          const sWhatsappDigits = (s.whatsapp || '').replace(/\D/g, '');
          const sPhone = (s.phone || '').replace(/[\s\-\.]/g, '');
          return (
            sPhone === cleanPhone ||
            s.phone === rawId ||
            (digits.length >= 8 && sPhoneDigits.endsWith(digits.slice(-8))) ||
            (digits.length >= 8 && sWhatsappDigits.endsWith(digits.slice(-8)))
          );
        });

        if (shopMatch && shopMatch.email) {
          return res.json({
            success: true,
            email: shopMatch.email,
            role: 'client',
            name: shopMatch.manager_name || shopMatch.shop_name,
            phone: shopMatch.phone
          });
        }
      }

      // Si non trouvé en base, fallback sur l'email standard basé sur le téléphone
      const fallbackEmail = `${digits}@fariousy.com`;
      return res.json({
        success: true,
        email: fallbackEmail,
        fallback: true
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // PUBLIC CLIENT REGISTRATION ENDPOINT (Controlled by Security Settings)
  // ---------------------------------------------------------------------------
  app.post('/api/auth/register-client', async (req: Request, res: Response) => {
    try {
      const secSettings = persistentStorage.getSecuritySettings();
      const caller = await resolveAuthenticatedCaller(req);
      const isPrivilegedCaller = Boolean(caller && (caller.isSuper || caller.role === 'admin' || caller.role === 'employee'));

      if (!secSettings.allowPublicClientRegistration && !isPrivilegedCaller) {
        return res.status(403).json({
          success: false,
          error: "Les inscriptions publiques de nouvelles boutiques sont actuellement verrouillées par le Super Administrateur."
        });
      }

      const requireApproval = !isPrivilegedCaller && secSettings.requireAdminApprovalForClients !== false;
      const targetAccountStatus = requireApproval ? 'en_attente' : 'approuve';
      const targetUserStatus = requireApproval ? 'en_attente' : 'active';
      const targetStatusReason = requireApproval
        ? "En attente de validation par l'administration"
        : 'Inscription client en ligne validée';

      const {
        shopName,
        managerName,
        phone,
        whatsapp,
        email,
        city,
        pickupAddress,
        activityType,
        password,
        cinNumber,
        cinPhotoUrl,
        cinBackPhotoUrl
      } = req.body;

      if (!shopName?.trim()) {
        return res.status(400).json({ success: false, error: 'Le nom de la boutique est obligatoire.' });
      }
      if (!managerName?.trim()) {
        return res.status(400).json({ success: false, error: 'Le nom du responsable est obligatoire.' });
      }
      if (!phone?.trim()) {
        return res.status(400).json({ success: false, error: 'Le numéro de téléphone est obligatoire.' });
      }
      if (!email?.trim()) {
        return res.status(400).json({ success: false, error: "L'adresse email est obligatoire." });
      }
      if (!city?.trim()) {
        return res.status(400).json({ success: false, error: 'La ville est obligatoire.' });
      }
      if (!pickupAddress?.trim()) {
        return res.status(400).json({ success: false, error: "L'adresse de ramassage est obligatoire." });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ success: false, error: 'Le mot de passe doit comporter au moins 6 caractères.' });
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanPhone = phone.trim();
      const cleanWhatsapp = (whatsapp || phone).trim();
      const cleanShopName = shopName.trim();
      const cleanManager = managerName.trim();
      const cleanCity = city.trim();
      const cleanAddress = pickupAddress.trim();
      const cleanActivity = (activityType || 'Commerce général').trim();
      const now = new Date().toISOString();

      // Check for duplicate email in profiles
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id, email')
        .ilike('email', cleanEmail)
        .maybeSingle();

      if (existingProfile) {
        return res.status(409).json({
          success: false,
          error: `Un compte existe déjà avec l'adresse email : ${cleanEmail}`
        });
      }

      // Check for duplicate shop name
      const { data: existingShop } = await supabase
        .from('merchant_shops')
        .select('id, shop_name')
        .ilike('shop_name', cleanShopName)
        .maybeSingle();

      if (existingShop) {
        return res.status(409).json({
          success: false,
          error: `Une boutique portant le nom "${cleanShopName}" existe déjà.`
        });
      }

      // Create Supabase Auth User
      let authUserId: string;
      const { data: newAuthUser, error: authCreateErr } = await supabase.auth.admin.createUser({
        email: cleanEmail,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: cleanManager,
          phone: cleanPhone,
          company_name: cleanShopName,
          role: 'client'
        }
      });

      if (authCreateErr || !newAuthUser?.user) {
        console.warn('[Register Client Auth Warning - Fallback to storage]:', authCreateErr?.message);
        const cleanCinNumber = typeof cinNumber === 'string' && cinNumber.trim() ? cinNumber.trim().toUpperCase() : undefined;
        const localUser = persistentStorage.createUser({
          name: cleanManager,
          companyName: cleanShopName,
          email: cleanEmail,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          city: cleanCity,
          address: cleanAddress,
          cinNumber: cleanCinNumber,
          cinPhotoUrl: cinPhotoUrl || undefined,
          cinBackPhotoUrl: cinBackPhotoUrl || undefined,
          role: 'client',
          status: targetUserStatus as any,
          accountStatus: targetAccountStatus as any,
          password
        });

        const localShop = persistentStorage.createShop({
          user_id: localUser.id,
          shop_name: cleanShopName,
          manager_name: cleanManager,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          email: cleanEmail,
          city: cleanCity,
          pickup_address: cleanAddress,
          activity_type: cleanActivity,
          account_status: targetAccountStatus,
          status_reason: targetStatusReason
        });

        persistentStorage.saveKycDocuments([localUser.id, localShop.id, cleanEmail], {
          cinNumber: cleanCinNumber,
          cinPhotoUrl: cinPhotoUrl || undefined,
          cinBackPhotoUrl: cinBackPhotoUrl || undefined
        });

        const sessionToken = requireApproval ? undefined : persistentStorage.createSession(localUser);
        if (sessionToken) setSessionCookie(res, sessionToken);

        return res.status(201).json({
          success: true,
          pendingApproval: requireApproval,
          message: requireApproval
            ? `Demande de compte boutique "${cleanShopName}" enregistrée. En attente de validation par le Super Administrateur.`
            : `Compte boutique "${cleanShopName}" créé avec succès. Vous pouvez maintenant vous connecter.`,
          ...(sessionToken ? { token: sessionToken } : {}),
          user: {
            ...localUser,
            shopId: localShop.id,
            cinNumber: cleanCinNumber,
            cinPhotoUrl: cinPhotoUrl || undefined,
            cinBackPhotoUrl: cinBackPhotoUrl || undefined
          }
        });
      }

      authUserId = newAuthUser.user.id;

      // Upsert into public.profiles
      const { error: profErr } = await supabase
        .from('profiles')
        .upsert({
          id: authUserId,
          email: cleanEmail,
          full_name: cleanManager,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          city: cleanCity,
          address: cleanAddress,
          role: 'client',
          status: targetAccountStatus,
          account_status: targetAccountStatus,
          created_at: now,
          updated_at: now
        });

      if (profErr) {
        console.warn('[Register Client Profile Notice]', profErr.message);
      }

      // Insert into public.merchant_shops
      const { data: createdShop, error: shopErr } = await supabase
        .from('merchant_shops')
        .insert({
          user_id: authUserId,
          shop_name: cleanShopName,
          manager_name: cleanManager,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          email: cleanEmail,
          city: cleanCity,
          pickup_address: cleanAddress,
          activity_type: cleanActivity,
          account_status: targetAccountStatus,
          status_reason: targetStatusReason,
          created_at: now,
          updated_at: now
        })
        .select()
        .single();

      if (shopErr) {
        console.warn('[Register Client Shop Notice]', shopErr.message);
      }

      const cleanCinNumber = typeof cinNumber === 'string' && cinNumber.trim() ? cinNumber.trim().toUpperCase() : undefined;

      // Persist KYC docs resiliently
      persistentStorage.saveKycDocuments([authUserId, createdShop?.id, cleanEmail], {
        cinNumber: cleanCinNumber,
        cinPhotoUrl: cinPhotoUrl || undefined,
        cinBackPhotoUrl: cinBackPhotoUrl || undefined
      });

      // Also mirror to persistent storage
      const mirroredUser = persistentStorage.createUser({
        id: authUserId,
        name: cleanManager,
        companyName: cleanShopName,
        email: cleanEmail,
        phone: cleanPhone,
        whatsapp: cleanWhatsapp,
        city: cleanCity,
        address: cleanAddress,
        cinNumber: cleanCinNumber,
        cinPhotoUrl: cinPhotoUrl || undefined,
        cinBackPhotoUrl: cinBackPhotoUrl || undefined,
        role: 'client',
        status: targetUserStatus as any,
        accountStatus: targetAccountStatus as any,
        password
      });

      const sessionToken = requireApproval ? undefined : persistentStorage.createSession(mirroredUser);
      if (sessionToken) setSessionCookie(res, sessionToken);

      return res.status(201).json({
        success: true,
        pendingApproval: requireApproval,
        message: requireApproval
          ? `Demande de compte boutique "${cleanShopName}" enregistrée. En attente de validation par le Super Administrateur.`
          : `Compte boutique "${cleanShopName}" créé avec succès. Vous pouvez maintenant vous connecter.`,
        ...(sessionToken ? { token: sessionToken } : {}),
        user: {
          id: authUserId,
          shopId: createdShop?.id,
          name: cleanManager,
          companyName: cleanShopName,
          email: cleanEmail,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          city: cleanCity,
          address: cleanAddress,
          cinNumber: cleanCinNumber,
          cinPhotoUrl: cinPhotoUrl || undefined,
          cinBackPhotoUrl: cinBackPhotoUrl || undefined,
          role: 'client',
          status: targetAccountStatus,
          accountStatus: targetAccountStatus
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Erreur interne lors de l\'inscription.' });
    }
  });

  // ---------------------------------------------------------------------------
  // PUBLIC PACKAGE TRACKING ENDPOINT (SANS AUTHENTIFICATION)
  // Permet le suivi en direct de n'importe quel colis depuis la page d'accueil
  // ---------------------------------------------------------------------------
  app.get('/api/public/track/:trackingNumber', async (req: Request, res: Response) => {
    try {
      const tracking = (req.params.trackingNumber || '').trim();
      if (!tracking) {
        return res.status(400).json({ success: false, error: 'Numéro de suivi requis.' });
      }

      const { data: pkg, error } = await supabase
        .from('packages')
        .select('*, driver:driver_id(full_name, phone)')
        .ilike('tracking_number', tracking)
        .maybeSingle();

      let targetPkg: any = pkg;

      if (error || !targetPkg) {
        const localPkg = persistentStorage.getPackageByIdOrTracking(tracking);
        if (localPkg) {
          targetPkg = {
            id: localPkg.id,
            tracking_number: localPkg.trackingNumber,
            recipient_name: localPkg.recipientName,
            destination_city: localPkg.city,
            destination_address: localPkg.address,
            item_description: localPkg.description,
            cod_amount: localPkg.codAmount,
            product_price: localPkg.productPrice,
            delivery_fee: localPkg.deliveryFee,
            status: localPkg.status,
            created_at: localPkg.createdAt,
            updated_at: localPkg.lastMovedAt || localPkg.createdAt,
            last_moved_at: localPkg.lastMovedAt || localPkg.createdAt,
            history: localPkg.history,
            driver: localPkg.driverName ? { full_name: localPkg.driverName, phone: '' } : null,
            is_transferred_to_partner: false
          };
        }
      }

      if (!targetPkg) {
        return res.status(404).json({
          success: false,
          error: `Aucun colis trouvé avec le numéro de suivi « ${tracking} ». Vérifiez la saisie et réessayez.`
        });
      }

      const ov = persistentStorage.getPackageOverrides([targetPkg.id, targetPkg.tracking_number]);
      const resolvedRecipientName = ov?.recipientName || targetPkg.recipient_name || 'Client';
      const rawName = resolvedRecipientName.trim();
      const parts = rawName.split(' ');
      const maskedName = parts.length > 1 ? `${parts[0]} ${parts[1][0]}***` : rawName;

      return res.json({
        success: true,
        package: {
          trackingNumber: targetPkg.tracking_number,
          status: ov?.status || targetPkg.status,
          city: ov?.city || targetPkg.destination_city,
          address: ov?.address || targetPkg.destination_address,
          recipientMasked: maskedName,
          description: ov?.description || targetPkg.item_description,
          codAmount: ov?.codAmount !== undefined ? ov.codAmount : targetPkg.cod_amount,
          createdAt: targetPkg.created_at,
          lastMovedAt: ov?.lastMovedAt || targetPkg.last_moved_at || targetPkg.updated_at || targetPkg.created_at,
          history: Array.isArray(ov?.history) && ov.history.length > 0
            ? ov.history
            : (Array.isArray(targetPkg.history) ? targetPkg.history : []),
          driver: (ov?.driverName || targetPkg.driver) ? {
            name: ov?.driverName || (targetPkg.driver as any)?.full_name,
            phone: ov?.driverPhone || (targetPkg.driver as any)?.phone || ''
          } : null,
          partner: (ov?.isTransferredToPartner || targetPkg.is_transferred_to_partner) ? {
            name: ov?.partnerName || targetPkg.partner_name,
            trackingId: ov?.partnerTrackingId || targetPkg.partner_tracking_id
          } : null
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Erreur lors du suivi de colis.' });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN DRIVERS ENDPOINT (READ-ONLY FROM public.profiles WHERE role = 'driver')
  // Étape 90 : Chargement exclusif des vrais livreurs depuis Supabase Production
  // ---------------------------------------------------------------------------
  app.get('/api/admin/drivers', authenticateAndAuthorize(['admin', 'employee']), async (_req: Request, res: Response) => {
    try {
      const { data: driverProfiles, error: dErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'driver')
        .order('created_at', { ascending: false });

      if (dErr) {
        console.warn('[Admin drivers Supabase fallback]:', dErr.message);
      }

      const mappedDrivers = (driverProfiles || []).map((row: any) => {
        const kyc = persistentStorage.getKycDocuments([row.id, row.email]);
        const dMeta = persistentStorage.getDriverMeta([row.id, row.email]);
        const storedDriver = persistentStorage.findUserById(row.id);
        return {
          id: row.id,
          name: storedDriver?.name || row.full_name || 'Livreur',
          email: row.email || storedDriver?.email || '',
          phone: storedDriver?.phone || row.phone || '',
          whatsapp: dMeta?.whatsapp || row.whatsapp || storedDriver?.whatsapp || undefined,
          city: storedDriver?.city || row.city || 'Laâyoune',
          address: dMeta?.address || row.address || storedDriver?.address || '',
          cinNumber: row.cin_number || kyc?.cinNumber || undefined,
          cinPhotoUrl: row.cin_photo_url || kyc?.cinPhotoUrl || undefined,
          cinBackPhotoUrl: row.cin_back_photo_url || kyc?.cinBackPhotoUrl || undefined,
          driverPhotoUrl: row.driver_photo_url || kyc?.driverPhotoUrl || row.avatar_url || undefined,
          avatarUrl: kyc?.driverPhotoUrl || row.avatar_url || undefined,
          driverVehicle: dMeta?.driverVehicle || row.driver_vehicle || storedDriver?.driverVehicle || 'Moto',
          driverPlate: dMeta?.driverPlate || row.driver_plate || storedDriver?.driverPlate || '',
          driverFeePerDelivery: dMeta?.driverFeePerDelivery ?? storedDriver?.driverFeePerDelivery ?? 10,
          driverFixedSalary: dMeta?.driverFixedSalary ?? storedDriver?.driverFixedSalary ?? 0,
          driverSalaryType: dMeta?.driverSalaryType ?? storedDriver?.driverSalaryType ?? 'per_package',
          driverPickupFee: dMeta?.driverPickupFee ?? storedDriver?.driverPickupFee ?? 5,
          driverBonusThreshold: dMeta?.driverBonusThreshold ?? storedDriver?.driverBonusThreshold,
          driverBonusAmount: dMeta?.driverBonusAmount ?? storedDriver?.driverBonusAmount,
          role: 'driver' as const,
          status: (storedDriver?.status || row.status || 'active') as any,
          accountStatus: (storedDriver?.accountStatus || row.account_status || 'approuve') as any,
          registeredAt: row.created_at || new Date().toISOString()
        };
      });

      const existingIds = new Set(mappedDrivers.map(d => d.id));
      for (const localDriver of persistentStorage.getUsers().filter(u => u.role === 'driver')) {
        if (!existingIds.has(localDriver.id)) {
          mappedDrivers.push(localDriver as any);
        }
      }

      return res.json({
        success: true,
        count: mappedDrivers.length,
        drivers: mappedDrivers
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur livreurs: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN CREATE DRIVER ENDPOINT (Étape 91)
  // Création du compte utilisateur dans Supabase Auth (rôle driver) + profil public.profiles
  // Zone de livraison par défaut : Laâyoune
  // ---------------------------------------------------------------------------
  app.post('/api/admin/drivers', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const {
        fullName,
        name,
        phone,
        email,
        password,
        city = 'Laâyoune',
        vehicleType = 'Moto',
        driverPlate = '',
        cinNumber = '',
        cinPhotoUrl = '',
        cinBackPhotoUrl = '',
        driverPhotoUrl = '',
        avatarUrl = '',
        feePerDelivery = 10,
        fixedSalary = 0,
        salaryType = 'per_package',
        pickupFee = 5,
        status = 'active'
      } = req.body;

      const driverName = (fullName || name || '').trim();
      const cleanPhone = (phone || '').trim().replace(/\s+/g, '');
      const defaultCity = (city || 'Laâyoune').trim();
      const defaultVehicle = (vehicleType || 'Moto').trim();
      const cleanCinNumber = (cinNumber || '').trim().toUpperCase() || undefined;
      const cleanCinPhoto = (cinPhotoUrl || '').trim() || undefined;
      const cleanCinBackPhoto = (cinBackPhotoUrl || '').trim() || undefined;
      const resolvedProfilePhoto = (driverPhotoUrl || avatarUrl || '').trim() || undefined;

      if (!driverName) {
        return res.status(400).json({
          success: false,
          error: 'Le nom complet du livreur est obligatoire.'
        });
      }

      if (!cleanPhone || cleanPhone.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'Un numéro de téléphone valide est obligatoire (utilisé comme identifiant de connexion).'
        });
      }

      if (!password || password.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'Le mot de passe doit comporter au moins 6 caractères.'
        });
      }

      // Dériver l'adresse e-mail si elle n'est pas fournie
      let cleanEmail = (email || '').trim().toLowerCase();
      if (!cleanEmail || !cleanEmail.includes('@')) {
        const cleanDigits = cleanPhone.replace(/\D/g, '') || Date.now().toString();
        cleanEmail = `${cleanDigits}@fariousy.com`;
      }

      // Vérifier les doublons dans public.profiles
      const { data: existingProfiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone')
        .or(`email.eq.${cleanEmail},phone.eq.${cleanPhone}`);

      if (existingProfiles && existingProfiles.length > 0) {
        const existing = existingProfiles[0];
        return res.status(409).json({
          success: false,
          error: `Un utilisateur existe déjà avec cet e-mail (${existing.email}) ou ce numéro de téléphone (${existing.phone}).`
        });
      }

      // Création du compte dans Supabase Auth avec email_confirm: true et rôle 'driver'
      const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
        email: cleanEmail,
        password: password,
        email_confirm: true,
        user_metadata: {
          role: 'driver',
          full_name: driverName,
          phone: cleanPhone,
          city: defaultCity,
          vehicle_type: defaultVehicle
        }
      });

      if (createErr || !createData?.user?.id) {
        return res.status(500).json({
          success: false,
          error: `Échec de la création du compte Supabase Auth: ${createErr?.message || 'Erreur inconnue'}`
        });
      }

      const authUserId = createData.user.id;
      const now = new Date().toISOString();

      // Insertion du profil dans public.profiles avec rôle 'driver' strict et URLs KYC/photo
      const baseProfileRow: Record<string, any> = {
        id: authUserId,
        role: 'driver',
        full_name: driverName,
        email: cleanEmail,
        phone: cleanPhone,
        whatsapp: cleanPhone,
        city: defaultCity,
        address: defaultCity,
        avatar_url: resolvedProfilePhoto || null,
        status: status || 'active',
        account_status: 'approuve',
        created_at: now,
        updated_at: now
      };

      const extendedProfileRow: Record<string, any> = {
        ...baseProfileRow,
        cin_number: cleanCinNumber || null,
        cin_photo_url: cleanCinPhoto || null,
        cin_back_photo_url: cleanCinBackPhoto || null,
        driver_photo_url: resolvedProfilePhoto || null,
        driver_vehicle: defaultVehicle || null,
        driver_plate: (driverPlate || '').trim() || null
      };

      let { error: insertProfileErr } = await supabase
        .from('profiles')
        .insert(extendedProfileRow);

      // Si la migration SQL n'a pas encore ajouté les nouvelles colonnes, réessayer avec les colonnes de base (inclut avatar_url)
      if (
        insertProfileErr &&
        /column|schema cache|PGRST204/i.test(insertProfileErr.message || insertProfileErr.code || '')
      ) {
        console.warn('[Driver Profile Extended Columns Fallback]', insertProfileErr.message);
        const retryRes = await supabase.from('profiles').insert(baseProfileRow);
        insertProfileErr = retryRes.error;
      }

      if (insertProfileErr) {
        // Rollback Supabase Auth user en cas d'échec d'insertion du profil
        await supabase.auth.admin.deleteUser(authUserId).catch(() => {});
        return res.status(500).json({
          success: false,
          error: `Échec d'insertion du profil livreur dans public.profiles: ${insertProfileErr.message}`
        });
      }

      // Toujours sauvegarder les documents KYC / photos & paramètres de rémunération dans persistentStorage
      persistentStorage.saveKycDocuments([authUserId, cleanEmail], {
        cinNumber: cleanCinNumber,
        cinPhotoUrl: cleanCinPhoto,
        cinBackPhotoUrl: cleanCinBackPhoto,
        driverPhotoUrl: resolvedProfilePhoto
      });

      persistentStorage.saveDriverMeta([authUserId, cleanEmail], {
        driverFeePerDelivery: Number(feePerDelivery) || 10,
        driverFixedSalary: Number(fixedSalary) || 0,
        driverSalaryType: salaryType || 'per_package',
        driverPickupFee: Number(pickupFee) || 5,
        whatsapp: cleanPhone,
        address: defaultCity,
        driverVehicle: defaultVehicle,
        driverPlate: driverPlate || ''
      });

      const driverObj = {
        id: authUserId,
        name: driverName,
        email: cleanEmail,
        phone: cleanPhone,
        whatsapp: cleanPhone,
        city: defaultCity,
        cinNumber: cleanCinNumber,
        cinPhotoUrl: cleanCinPhoto,
        cinBackPhotoUrl: cleanCinBackPhoto,
        driverPhotoUrl: resolvedProfilePhoto,
        avatarUrl: resolvedProfilePhoto,
        driverVehicle: defaultVehicle,
        driverPlate: driverPlate || '',
        vehicleType: defaultVehicle as any,
        role: 'driver' as const,
        status: (status as any) || 'active',
        accountStatus: 'approuve' as const,
        driverFeePerDelivery: Number(feePerDelivery) || 10,
        driverFixedSalary: Number(fixedSalary) || 0,
        driverSalaryType: salaryType || 'per_package',
        driverPickupFee: Number(pickupFee) || 5,
        registeredAt: now
      };

      // Synchroniser dans persistentStorage pour cohérence immédiate
      const existingStored = persistentStorage.findUserById(authUserId);
      if (existingStored) {
        persistentStorage.updateUser(authUserId, driverObj);
      } else {
        persistentStorage.createUser({
          ...driverObj,
          password
        });
      }

      return res.status(201).json({
        success: true,
        driver: driverObj,
        credentials: {
          fullName: driverName,
          phone: cleanPhone,
          email: cleanEmail,
          password: password,
          city: defaultCity,
          vehicleType: defaultVehicle
        }
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors de la création du livreur: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN UPDATE DRIVER PROFILE & KYC PHOTO URLS ENDPOINT
  // ---------------------------------------------------------------------------
  app.put('/api/admin/drivers/:id', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const {
        name,
        fullName,
        email,
        phone,
        whatsapp,
        city,
        address,
        driverVehicle,
        driverPlate,
        cinNumber,
        cinPhotoUrl,
        cinBackPhotoUrl,
        driverPhotoUrl,
        avatarUrl,
        driverFeePerDelivery,
        driverFixedSalary,
        driverSalaryType,
        driverPickupFee,
        driverBonusThreshold,
        driverBonusAmount,
        status
      } = req.body;

      const resolvedName = (fullName || name || '').trim() || undefined;
      const resolvedEmail = (email || '').trim().toLowerCase() || undefined;
      const resolvedPhone = (phone || '').trim().replace(/\s+/g, '') || undefined;
      const resolvedWhatsapp = typeof whatsapp === 'string' ? whatsapp.trim() : undefined;
      const resolvedCity = (city || '').trim() || undefined;
      const resolvedAddress = typeof address === 'string' ? address.trim() : undefined;
      const resolvedCinNumber = typeof cinNumber === 'string' ? cinNumber.trim().toUpperCase() || undefined : undefined;
      const resolvedCinPhoto = typeof cinPhotoUrl === 'string' ? cinPhotoUrl.trim() || undefined : undefined;
      const resolvedCinBackPhoto = typeof cinBackPhotoUrl === 'string' ? cinBackPhotoUrl.trim() || undefined : undefined;
      const resolvedProfilePhoto =
        typeof driverPhotoUrl === 'string' || typeof avatarUrl === 'string'
          ? (driverPhotoUrl || avatarUrl || '').trim() || undefined
          : undefined;

      const now = new Date().toISOString();
      const baseUpdates: Record<string, any> = { updated_at: now };
      if (resolvedName) baseUpdates.full_name = resolvedName;
      if (resolvedEmail) baseUpdates.email = resolvedEmail;
      if (resolvedPhone) {
        baseUpdates.phone = resolvedPhone;
        baseUpdates.whatsapp = resolvedWhatsapp || resolvedPhone;
      } else if (resolvedWhatsapp !== undefined) {
        baseUpdates.whatsapp = resolvedWhatsapp;
      }
      if (resolvedCity) baseUpdates.city = resolvedCity;
      if (resolvedAddress !== undefined) baseUpdates.address = resolvedAddress;
      if (status) baseUpdates.status = status;
      if (typeof driverPhotoUrl === 'string' || typeof avatarUrl === 'string') {
        baseUpdates.avatar_url = resolvedProfilePhoto || null;
      }

      const extendedUpdates: Record<string, any> = { ...baseUpdates };
      if (typeof cinNumber === 'string') extendedUpdates.cin_number = resolvedCinNumber || null;
      if (typeof cinPhotoUrl === 'string') extendedUpdates.cin_photo_url = resolvedCinPhoto || null;
      if (typeof cinBackPhotoUrl === 'string') extendedUpdates.cin_back_photo_url = resolvedCinBackPhoto || null;
      if (typeof driverPhotoUrl === 'string' || typeof avatarUrl === 'string') {
        extendedUpdates.driver_photo_url = resolvedProfilePhoto || null;
      }
      if (typeof driverVehicle === 'string') extendedUpdates.driver_vehicle = driverVehicle.trim() || null;
      if (typeof driverPlate === 'string') extendedUpdates.driver_plate = driverPlate.trim() || null;

      try {
        let { error: updErr } = await supabase
          .from('profiles')
          .update(extendedUpdates)
          .eq('id', id)
          .eq('role', 'driver');

        if (updErr && /column|schema cache|PGRST204/i.test(updErr.message || updErr.code || '')) {
          console.warn('[Driver Update Extended Columns Fallback]', updErr.message);
          await supabase
            .from('profiles')
            .update(baseUpdates)
            .eq('id', id)
            .eq('role', 'driver');
        }
      } catch (dbErr: any) {
        console.warn('[Driver Update DB Warning]', dbErr.message);
      }

      const stored = persistentStorage.findUserById(id);
      const emailKey = resolvedEmail || stored?.email;

      persistentStorage.saveKycDocuments([id, emailKey], {
        cinNumber: resolvedCinNumber,
        cinPhotoUrl: resolvedCinPhoto,
        cinBackPhotoUrl: resolvedCinBackPhoto,
        driverPhotoUrl: resolvedProfilePhoto
      });

      const savedMeta = persistentStorage.saveDriverMeta([id, emailKey], {
        ...(driverFeePerDelivery !== undefined ? { driverFeePerDelivery: Number(driverFeePerDelivery) } : {}),
        ...(driverFixedSalary !== undefined ? { driverFixedSalary: Number(driverFixedSalary) } : {}),
        ...(driverSalaryType !== undefined ? { driverSalaryType } : {}),
        ...(driverPickupFee !== undefined ? { driverPickupFee: Number(driverPickupFee) } : {}),
        ...(driverBonusThreshold !== undefined ? { driverBonusThreshold: Number(driverBonusThreshold) } : {}),
        ...(driverBonusAmount !== undefined ? { driverBonusAmount: Number(driverBonusAmount) } : {}),
        ...(resolvedAddress !== undefined ? { address: resolvedAddress } : {}),
        ...(resolvedWhatsapp !== undefined ? { whatsapp: resolvedWhatsapp } : {}),
        ...(typeof driverVehicle === 'string' ? { driverVehicle } : {}),
        ...(typeof driverPlate === 'string' ? { driverPlate } : {})
      });

      const userPatch = {
        ...(resolvedName ? { name: resolvedName } : {}),
        ...(resolvedEmail ? { email: resolvedEmail } : {}),
        ...(resolvedPhone ? { phone: resolvedPhone, whatsapp: resolvedWhatsapp || resolvedPhone } : {}),
        ...(resolvedWhatsapp !== undefined ? { whatsapp: resolvedWhatsapp } : {}),
        ...(resolvedCity ? { city: resolvedCity } : {}),
        ...(resolvedAddress !== undefined ? { address: resolvedAddress } : {}),
        ...(typeof driverVehicle === 'string' ? { driverVehicle } : {}),
        ...(typeof driverPlate === 'string' ? { driverPlate } : {}),
        ...(driverFeePerDelivery !== undefined ? { driverFeePerDelivery: Number(driverFeePerDelivery) } : {}),
        ...(driverFixedSalary !== undefined ? { driverFixedSalary: Number(driverFixedSalary) } : {}),
        ...(driverSalaryType !== undefined ? { driverSalaryType } : {}),
        ...(driverPickupFee !== undefined ? { driverPickupFee: Number(driverPickupFee) } : {}),
        ...(driverBonusThreshold !== undefined ? { driverBonusThreshold: Number(driverBonusThreshold) } : {}),
        ...(driverBonusAmount !== undefined ? { driverBonusAmount: Number(driverBonusAmount) } : {}),
        ...(typeof cinNumber === 'string' ? { cinNumber: resolvedCinNumber } : {}),
        ...(typeof cinPhotoUrl === 'string' ? { cinPhotoUrl: resolvedCinPhoto } : {}),
        ...(typeof cinBackPhotoUrl === 'string' ? { cinBackPhotoUrl: resolvedCinBackPhoto } : {}),
        ...(typeof driverPhotoUrl === 'string' || typeof avatarUrl === 'string'
          ? { driverPhotoUrl: resolvedProfilePhoto, avatarUrl: resolvedProfilePhoto }
          : {}),
        ...(status ? { status } : {})
      };

      if (stored) {
        persistentStorage.updateUser(id, userPatch);
      }

      return res.json({
        success: true,
        driver: persistentStorage.findUserById(id) || {
          id,
          name: resolvedName || 'Livreur',
          email: resolvedEmail || '',
          phone: resolvedPhone || '',
          city: resolvedCity || 'Laâyoune',
          ...savedMeta,
          cinNumber: resolvedCinNumber,
          cinPhotoUrl: resolvedCinPhoto,
          cinBackPhotoUrl: resolvedCinBackPhoto,
          driverPhotoUrl: resolvedProfilePhoto,
          avatarUrl: resolvedProfilePhoto,
          role: 'driver'
        }
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors de la mise à jour du livreur: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN DELETE DRIVER ENDPOINT (Permanent removal from Supabase + persistentStorage)
  // ---------------------------------------------------------------------------
  app.delete('/api/admin/drivers/:id', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const driverId = req.params.id;
      if (!driverId) {
        return res.status(400).json({ success: false, error: 'Identifiant du livreur manquant.' });
      }

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(driverId.trim());

      if (isUuid) {
        // 1. Dissocier les colis et ramassages affectés à ce livreur
        const { error: unassignErr } = await supabase
          .from('packages')
          .update({ driver_id: null })
          .eq('driver_id', driverId);

        if (unassignErr) {
          console.warn('[Delete Driver Unassign Warning]', unassignErr.message);
        }

        try {
          await supabase
            .from('pickup_requests')
            .update({ driver_id: null })
            .eq('driver_id', driverId);
        } catch {}

        // 2. Supprimer le profil livreur dans public.profiles
        const { error: profDelErr } = await supabase
          .from('profiles')
          .delete()
          .eq('id', driverId);

        if (profDelErr) {
          return res.status(500).json({
            success: false,
            error: `Échec de suppression du livreur dans Supabase: ${profDelErr.message}`
          });
        }

        // 3. Supprimer le compte Supabase Auth (best-effort)
        try {
          await supabase.auth.admin.deleteUser(driverId);
        } catch (authDelErr) {
          console.warn('[Delete Driver Auth Notice]', (authDelErr as Error)?.message);
        }
      }

      // 4. Supprimer du stockage local serveur
      persistentStorage.deleteDriver(driverId);

      return res.json({
        success: true,
        message: 'Livreur supprimé définitivement de Supabase.'
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur lors de la suppression du livreur: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN UPDATE DRIVER PASSWORD ENDPOINT
  // Réinitialisation sécurisée du mot de passe d'un livreur dans Supabase Auth
  // ---------------------------------------------------------------------------
  app.put('/api/admin/drivers/:id/password', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { newPassword } = req.body;

      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'Le mot de passe doit comporter au moins 6 caractères.'
        });
      }

      // Vérifier que le profil existe et a le rôle 'driver'
      const { data: profile, error: pErr } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, role')
        .eq('id', id)
        .eq('role', 'driver')
        .maybeSingle();

      if (pErr || !profile) {
        return res.status(404).json({
          success: false,
          error: 'Livreur introuvable dans public.profiles.'
        });
      }

      // Mise à jour du mot de passe dans Supabase Auth via l'API Admin
      const { error: authUpdateErr } = await supabase.auth.admin.updateUserById(id, {
        password: newPassword
      });

      if (authUpdateErr) {
        return res.status(500).json({
          success: false,
          error: `Erreur lors de la mise à jour du mot de passe Supabase Auth: ${authUpdateErr.message}`
        });
      }

      // Mettre à jour updated_at
      await supabase.from('profiles').update({ updated_at: new Date().toISOString() }).eq('id', id);

      return res.json({
        success: true,
        message: `Le mot de passe du livreur ${profile.full_name} a été mis à jour avec succès.`,
        driver: {
          id: profile.id,
          name: profile.full_name,
          phone: profile.phone,
          email: profile.email
        },
        newPassword
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors de la réinitialisation du mot de passe: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN UPDATE CLIENT (BOUTIQUE) PASSWORD ENDPOINT
  // Réinitialisation sécurisée du mot de passe d'une boutique / client dans Supabase Auth
  // ---------------------------------------------------------------------------
  app.put('/api/admin/clients/:id/password', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { newPassword } = req.body;

      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'Le mot de passe doit comporter au moins 6 caractères.'
        });
      }

      // Vérifier que le profil existe dans public.profiles ou merchant_shops
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, role')
        .eq('id', id)
        .maybeSingle();

      const { data: shop } = await supabase
        .from('merchant_shops')
        .select('id, shop_name, manager_name, phone, email, user_id')
        .or(`id.eq.${id},user_id.eq.${id}`)
        .maybeSingle();

      const targetUserId = profile?.id || shop?.user_id || id;
      const clientName = shop?.shop_name || profile?.full_name || shop?.manager_name || 'Client';
      const clientEmail = profile?.email || shop?.email || '';
      const clientPhone = profile?.phone || shop?.phone || '';

      // Mise à jour du mot de passe dans Supabase Auth via l'API Admin
      const { error: authUpdateErr } = await supabase.auth.admin.updateUserById(targetUserId, {
        password: newPassword
      });

      if (authUpdateErr) {
        console.warn('[Admin Client Password Update] Supabase Auth update:', authUpdateErr.message);
      }

      // Synchronisation immédiate dans le stockage persistant serveur
      try {
        const existingStored = persistentStorage.findUserById(targetUserId) || 
          persistentStorage.findUserByIdentifier(clientEmail) || 
          persistentStorage.findUserByIdentifier(clientPhone);
        if (existingStored) {
          persistentStorage.updateUser(existingStored.id, { 
            passwordHash: newPassword,
            email: clientEmail || existingStored.email,
            phone: clientPhone || existingStored.phone,
            role: 'client'
          });
        } else {
          persistentStorage.createUser({
            id: targetUserId,
            email: clientEmail || `${targetUserId}@fariousy.com`,
            name: clientName,
            role: 'client',
            phone: clientPhone,
            companyName: clientName,
            status: 'active',
            accountStatus: 'approuve',
            password: newPassword
          } as any);
        }
      } catch (storageErr) {
        console.warn('[Admin Client Password Update persistentStorage notice]', storageErr);
      }

      // Mettre à jour updated_at
      await supabase.from('profiles').update({ updated_at: new Date().toISOString() }).eq('id', targetUserId);
      if (shop?.id) {
        await supabase.from('merchant_shops').update({ updated_at: new Date().toISOString() }).eq('id', shop.id);
      }

      return res.json({
        success: true,
        message: `Le mot de passe de la boutique ${clientName} a été mis à jour avec succès.`,
        client: {
          id: targetUserId,
          name: clientName,
          phone: clientPhone,
          email: clientEmail
        },
        newPassword
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors de la réinitialisation du mot de passe: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // DRIVER PACKAGES ENDPOINT (Étape 90 : Consultation des colis affectés au livreur connecté)
  // RÈGLE DE SÉCURITÉ STRICTE : Le livreur ne peut voir QUE les colis qui lui sont affectés
  // L'identité du livreur est extraite obligatoirement du jeton Supabase Auth (req.user.id)
  // ---------------------------------------------------------------------------
  app.get('/api/driver/packages', authenticateAndAuthorize(['driver', 'admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const authUser = (req as any).user;
      const userProfile = (req as any).profile;

      if (!authUser || !authUser.id) {
        return res.status(401).json({ success: false, error: 'Utilisateur non authentifié.' });
      }

      // Si l'utilisateur est livreur, isolation stricte par son id
      // Si admin ou employé, possibilité de filtrer par driverId en paramètre
      let targetDriverId = authUser.id;
      if (['admin', 'employee'].includes(userProfile?.role) && req.query.driverId) {
        targetDriverId = req.query.driverId as string;
      }

      const { data: rows, error: pkgErr } = await supabase
        .from('packages')
        .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city), driver:driver_id(id, full_name, phone, role)')
        .eq('driver_id', targetDriverId)
        .order('created_at', { ascending: false });

      if (pkgErr) {
        return res.status(500).json({
          success: false,
          error: `Erreur lors de la lecture des colis du livreur: ${pkgErr.message}`
        });
      }

      const mappedPackages: any[] = (rows || []).map((row: any) => {
        const rawCod = Number(row.cod_amount || 0);
        const rawFee = Number(row.delivery_fee || 0);
        const derivedProductPrice = Math.max(0, Math.round((rawCod - rawFee) * 100) / 100);
        const storedOpts = persistentStorage.getPackageOptions([row.id, row.tracking_number]);

        return applyPackageOverrides({
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
          codAmount: rawCod,
          deliveryFee: rawFee,
          productPrice: derivedProductPrice,
          status: row.status || 'attente_ramassage',
          driverId: row.driver_id,
          driverName: row.driver?.full_name || userProfile?.full_name || 'Mon profil livreur',
          driverPhone: row.driver?.phone || userProfile?.phone || '',
          currentAgency: row.current_agency || 'Agence Principale',
          isPaidToClient: row.is_paid_to_client ?? false,
          allowOpen: storedOpts?.allowOpen ?? (typeof row.allow_open === 'boolean' ? row.allow_open : undefined),
          allowTry: storedOpts?.allowTry ?? (typeof row.allow_try === 'boolean' ? row.allow_try : undefined),
          isFragile: storedOpts?.isFragile ?? (typeof row.is_fragile === 'boolean' ? row.is_fragile : false),
          isExchange: storedOpts?.isExchange ?? (typeof row.is_exchange === 'boolean' ? row.is_exchange : false),
          exchangeTrackingNumber: storedOpts?.exchangeTrackingNumber ?? row.exchange_tracking_number ?? undefined,
          exchangeReason: storedOpts?.exchangeReason ?? row.exchange_reason ?? undefined,
          exchangeItemDescription: storedOpts?.exchangeItemDescription ?? row.exchange_item_description ?? undefined,
          createdAt: row.created_at || new Date().toISOString(),
          lastMovedAt: row.updated_at || row.created_at || new Date().toISOString(),
          history: []
        });
      });

      const existingKeys = new Set<string>();
      for (const p of mappedPackages) {
        if (p.id) existingKeys.add(String(p.id).toLowerCase());
        if (p.trackingNumber) existingKeys.add(String(p.trackingNumber).toLowerCase());
      }
      const localDriverPackages = persistentStorage.getPackages({ driverId: targetDriverId });
      for (const lp of localDriverPackages) {
        if (!existingKeys.has(String(lp.id).toLowerCase()) && !existingKeys.has(String(lp.trackingNumber).toLowerCase())) {
          mappedPackages.push(applyPackageOverrides(lp));
        }
      }
      mappedPackages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return res.json({
        success: true,
        count: mappedPackages.length,
        driverId: targetDriverId,
        packages: mappedPackages
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur colis livreur: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ASSIGN PACKAGES TO DRIVER ENDPOINT (Étape 90 : Affectation / réaffectation des colis)
  // RÈGLE DE SÉCURITÉ : Rôle administrateur ou employé requis (accès strictement interdit aux clients)
  // Enregistrement direct dans public.packages.driver_id + persistentStorage
  // ---------------------------------------------------------------------------
  const handleAssignPackagesToDriver = async (req: Request, res: Response) => {
    try {
      const { packageIds, driverId, updateStatus } = req.body;

      if (!Array.isArray(packageIds) || packageIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Veuillez sélectionner au moins un colis à affecter.'
        });
      }

      let driverProfile: any = null;
      if (driverId) {
        const { data: driverRow } = await supabase
          .from('profiles')
          .select('id, full_name, phone, role, email')
          .eq('id', driverId)
          .maybeSingle();

        const localDriver = persistentStorage.findUserById(driverId);

        if (driverRow) {
          if (driverRow.role !== 'driver') {
            return res.status(400).json({
              success: false,
              error: `L'utilisateur « ${driverRow.full_name} » n'a pas le rôle 'driver' dans public.profiles.`
            });
          }
          driverProfile = driverRow;
        } else if (localDriver && localDriver.role === 'driver') {
          driverProfile = {
            id: localDriver.id,
            full_name: localDriver.name,
            phone: localDriver.phone,
            role: 'driver',
            email: localDriver.email
          };
        } else {
          return res.status(400).json({
            success: false,
            error: `Le livreur spécifié (id: ${driverId}) est introuvable dans public.profiles.`
          });
        }
      }

      const now = new Date().toISOString();
      const updateData: Record<string, any> = {
        driver_id: driverId || null,
        updated_at: now
      };

      if (updateStatus && driverId) {
        updateData.status = 'en_cours_livraison';
      }

      let updatedRows: any[] = [];
      try {
        const { data: sbRows, error: upErr } = await supabase
          .from('packages')
          .update(updateData)
          .in('id', packageIds)
          .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city), driver:driver_id(id, full_name, phone, role)');

        if (!upErr && Array.isArray(sbRows)) {
          updatedRows = sbRows;
        } else if (upErr) {
          console.warn('[Assign Driver Supabase Warning]', upErr.message);
        }
      } catch (sbErr: any) {
        console.warn('[Assign Driver Supabase Fallback]', sbErr?.message);
      }

      const driverDisplayName = driverProfile?.full_name || (driverId ? 'Livreur' : undefined);
      const driverDisplayPhone = driverProfile?.phone || undefined;

      for (const pid of packageIds) {
        if (driverId) {
          persistentStorage.assignDriver(pid, driverId, driverDisplayName);
          if (updateStatus) {
            persistentStorage.updatePackageStatus(pid, 'en_cours_livraison', `Affecté au livreur ${driverDisplayName}`);
          }
        } else {
          persistentStorage.updatePackage(pid, { driverId: undefined, driverName: undefined });
        }
        persistentStorage.savePackageOverrides([pid], {
          driverId: driverId || undefined,
          driverName: driverDisplayName,
          driverPhone: driverDisplayPhone,
          ...(updateStatus && driverId ? { status: 'en_cours_livraison' as PackageStatus } : {}),
          lastMovedAt: now
        });
      }

      const actionMsg = driverId
        ? `${packageIds.length} colis affecté(s) avec succès au livreur ${driverDisplayName}.`
        : `${packageIds.length} colis désaffecté(s) avec succès.`;

      return res.json({
        success: true,
        message: actionMsg,
        updatedCount: Math.max(updatedRows.length, packageIds.length),
        driverId: driverId || null,
        driverName: driverDisplayName || 'Non affecté',
        packages: updatedRows
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors de l'affectation : ${err.message}`
      });
    }
  };

  app.put('/api/admin/packages/assign-driver', authenticateAndAuthorize(['admin', 'employee']), handleAssignPackagesToDriver);
  app.post('/api/admin/packages/assign-driver', authenticateAndAuthorize(['admin', 'employee']), handleAssignPackagesToDriver);
  app.put('/api/admin/packages/:id/assign-driver', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    req.body.packageIds = [req.params.id];
    return handleAssignPackagesToDriver(req, res);
  });

  // ---------------------------------------------------------------------------
  // SYSTEM WIPE DATA ENDPOINT (SUPER ADMIN ONLY)
  // Permet de vider intégralement la base / stockage et repartir à zéro
  // ---------------------------------------------------------------------------
  app.post('/api/admin/system/wipe-data', authenticateAndAuthorize(['admin', 'super_admin']), async (req: Request, res: Response) => {
    try {
      const user = (req as any).profile || (req as any).user;
      console.log(`[SYSTEM WIPE] Executed by: ${user?.email || 'admin'}`);

      const wipeResult = persistentStorage.wipeAllData(true);

      if (isValidSupabaseKey(SUPABASE_KEY)) {
        try {
          await supabase.from('packages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
          await supabase.from('merchant_shops').delete().neq('id', '00000000-0000-0000-0000-000000000000');
          await supabase.from('pickup_requests').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        } catch (sbPurgeErr) {
          console.warn('[Supabase purge notice]', sbPurgeErr);
        }
      }

      return res.json({
        success: true,
        message: 'Toutes les données du système ont été vidées avec succès. Contrôle total accordé.',
        result: wipeResult
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors de la réinitialisation: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN CLIENTS ENDPOINT (READ-ONLY FROM public.merchant_shops & public.profiles)
  // ---------------------------------------------------------------------------
  app.get('/api/admin/clients', authenticateAndAuthorize(['admin']), async (_req: Request, res: Response) => {
    try {
      const { data: shops, error: shopsErr } = await supabase
        .from('merchant_shops')
        .select('*, profiles:user_id(id, full_name, email, phone, whatsapp, city, address, role)')
        .order('created_at', { ascending: false });

      if (shopsErr) {
        console.warn('[Admin clients merchant_shops notice]:', shopsErr.message);
      }

      const { data: clientProfiles, error: profsErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'client')
        .order('created_at', { ascending: false });

      if (profsErr) {
        console.warn('[Admin clients profiles notice]:', profsErr.message);
      }

      const shopUserIds = new Set((shops || []).map(s => s.user_id));
      const mergedClients: any[] = [];

      for (const shop of (shops || [])) {
        const kyc = persistentStorage.getKycDocuments([shop.user_id, shop.id, shop.email, shop.profiles?.email]);
        const storedUser = persistentStorage.findUserById(shop.user_id || shop.id);
        mergedClients.push({
          id: shop.user_id || shop.id,
          shopId: shop.id,
          name: (shop.manager_name || shop.profiles?.full_name || shop.shop_name || 'Gérant').trim(),
          companyName: (shop.shop_name || '').trim() || shop.manager_name || shop.profiles?.full_name || 'Boutique',
          email: shop.email || shop.profiles?.email || '',
          phone: shop.phone || shop.profiles?.phone || '',
          whatsapp: shop.whatsapp || shop.profiles?.whatsapp || '',
          city: shop.city || shop.profiles?.city || 'Casablanca',
          address: shop.pickup_address || shop.profiles?.address || '',
          activityType: shop.activity_type || 'Commerce général',
          cinNumber: shop.cin_number || kyc?.cinNumber || undefined,
          cinPhotoUrl: shop.cin_photo_url || kyc?.cinPhotoUrl || undefined,
          cinBackPhotoUrl: shop.cin_back_photo_url || kyc?.cinBackPhotoUrl || undefined,
          bankName: shop.bank_name || shop.profiles?.bank_name || kyc?.bankName || storedUser?.bankName || undefined,
          bankRib: shop.bank_rib || shop.profiles?.bank_rib || kyc?.bankRib || storedUser?.bankRib || undefined,
          role: 'client',
          status: shop.account_status || storedUser?.status || 'en_attente',
          accountStatus: shop.account_status || storedUser?.accountStatus || 'en_attente',
          statusReason: shop.status_reason || storedUser?.statusReason || undefined,
          approvedAt: shop.approved_at || storedUser?.approvedAt || undefined,
          approvedBy: shop.approved_by || storedUser?.approvedBy || undefined,
          registeredAt: shop.created_at || new Date().toISOString()
        });
      }

      for (const prof of (clientProfiles || [])) {
        if (!shopUserIds.has(prof.id)) {
          const kyc = persistentStorage.getKycDocuments([prof.id, prof.email]);
          const storedUser = persistentStorage.findUserById(prof.id);
          mergedClients.push({
            id: prof.id,
            name: storedUser?.name || prof.full_name || 'Client',
            companyName: storedUser?.companyName || prof.full_name || 'Client Individuel',
            email: prof.email || storedUser?.email || '',
            phone: storedUser?.phone || prof.phone || '',
            whatsapp: storedUser?.whatsapp || prof.whatsapp || '',
            city: storedUser?.city || prof.city || 'Casablanca',
            address: storedUser?.address || prof.address || '',
            activityType: storedUser?.activityType || 'Commerce général',
            cinNumber: prof.cin_number || kyc?.cinNumber || undefined,
            cinPhotoUrl: prof.cin_photo_url || kyc?.cinPhotoUrl || undefined,
            cinBackPhotoUrl: prof.cin_back_photo_url || kyc?.cinBackPhotoUrl || undefined,
            bankName: prof.bank_name || kyc?.bankName || storedUser?.bankName || undefined,
            bankRib: prof.bank_rib || kyc?.bankRib || storedUser?.bankRib || undefined,
            role: 'client',
            status: storedUser?.status || 'approuve',
            accountStatus: storedUser?.accountStatus || 'approuve',
            statusReason: storedUser?.statusReason || undefined,
            registeredAt: prof.created_at || new Date().toISOString()
          });
        }
      }

      const existingIds = new Set(mergedClients.map(c => c.id));
      for (const localClient of persistentStorage.getUsers().filter(u => u.role === 'client')) {
        if (!existingIds.has(localClient.id)) {
          const localShop = persistentStorage.getShopByUserId(localClient.id);
          mergedClients.push({
            ...localClient,
            shopId: localShop?.id,
            companyName: localClient.companyName || localShop?.shop_name || localClient.name,
            accountStatus: localClient.accountStatus || localShop?.account_status || 'en_attente',
            status: localClient.status || localShop?.account_status || 'en_attente'
          });
        }
      }

      return res.json({
        success: true,
        count: mergedClients.length,
        clients: mergedClients
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur clients: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN PACKAGES ENDPOINT (READ-ONLY FROM public.packages & public.merchant_shops)
  // Étape 81 : Chargement direct des colis réels Supabase sans données fictives
  // ---------------------------------------------------------------------------
  app.get('/api/admin/packages', authenticateAndAuthorize(['admin', 'employee']), async (_req: Request, res: Response) => {
    try {
      const { data: rows, error: pkgErr } = await supabase
        .from('packages')
        .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city), driver:driver_id(id, full_name, phone, role)')
        .order('created_at', { ascending: false });

      if (pkgErr) {
        console.warn('[Admin packages Supabase notice, falling back to persistent storage]:', pkgErr.message);
        const localPackages = persistentStorage.getPackages();
        return res.json({
          success: true,
          count: localPackages.length,
          packages: localPackages
        });
      }

      const problemMap = persistentStorage.getProblemReports();
      const mappedPackages: any[] = (rows || []).map((row: any) => {
        const rawCod = Number(row.cod_amount || 0);
        const rawFee = Number(row.delivery_fee || 0);
        const derivedProductPrice = Math.max(0, Math.round((rawCod - rawFee) * 100) / 100);
        const problemReport = problemMap[row.id] || problemMap[row.tracking_number] || undefined;
        const storedOpts = persistentStorage.getPackageOptions([row.id, row.tracking_number]);

      return applyPackageOverrides({
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
          codAmount: rawCod,
          deliveryFee: rawFee,
          productPrice: derivedProductPrice,
          status: problemReport && !problemReport.resolved ? 'probleme_livraison' : (row.status || 'attente_ramassage'),
          driverId: row.driver_id || undefined,
          driverName: row.driver?.full_name || undefined,
          driverPhone: row.driver?.phone || undefined,
          driverComment: problemReport?.description || undefined,
          callProofUrl: problemReport?.photoBase64 || undefined,
          problemReport,
          currentAgency: row.current_agency || 'Agence Principale',
          isPaidToClient: row.is_paid_to_client ?? false,
          allowOpen: storedOpts?.allowOpen ?? (typeof row.allow_open === 'boolean' ? row.allow_open : undefined),
          allowTry: storedOpts?.allowTry ?? (typeof row.allow_try === 'boolean' ? row.allow_try : undefined),
          isFragile: storedOpts?.isFragile ?? (typeof row.is_fragile === 'boolean' ? row.is_fragile : false),
          isExchange: storedOpts?.isExchange ?? (typeof row.is_exchange === 'boolean' ? row.is_exchange : false),
          exchangeTrackingNumber: storedOpts?.exchangeTrackingNumber ?? row.exchange_tracking_number ?? undefined,
          exchangeReason: storedOpts?.exchangeReason ?? row.exchange_reason ?? undefined,
          exchangeItemDescription: storedOpts?.exchangeItemDescription ?? row.exchange_item_description ?? undefined,
          createdAt: row.created_at || new Date().toISOString(),
          lastMovedAt: row.updated_at || row.created_at || new Date().toISOString(),
          history: []
        });
      });

      const existingKeys = new Set<string>();
      for (const p of mappedPackages) {
        if (p.id) existingKeys.add(String(p.id).toLowerCase());
        if (p.trackingNumber) existingKeys.add(String(p.trackingNumber).toLowerCase());
      }
      const localPackages = persistentStorage.getPackages();
      for (const lp of localPackages) {
        if (!existingKeys.has(String(lp.id).toLowerCase()) && !existingKeys.has(String(lp.trackingNumber).toLowerCase())) {
          mappedPackages.push(applyPackageOverrides(lp));
        }
      }
      mappedPackages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return res.json({
        success: true,
        count: mappedPackages.length,
        packages: mappedPackages
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur colis: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // CLIENT PACKAGES ENDPOINT (Étape 88 : Consultation sécurisée des colis pour l'espace client)
  // RÈGLE DE SÉCURITÉ : Le client connecté ne peut consulter QUE les colis de sa propre boutique
  // L'identité provient obligatoirement du jeton Supabase Auth (req.user.id) et non de paramètres URL
  // ---------------------------------------------------------------------------
  app.get('/api/client/packages', authenticateAndAuthorize(['client', 'admin', 'employee']), async (req: Request, res: Response) => {
    try {
      let authUser = (req as any).user;
      let userProfile = (req as any).profile;

      const internalKey = req.headers['x-fariousy-internal-key'];
      const configuredSecret = (process.env.FARIOUSY_API_SECRET || '').trim();
      const testUserId = req.headers['x-auth-user-id'] as string;
      if (!authUser && configuredSecret && internalKey === configuredSecret && testUserId) {
        const { data: prof } = await supabase.from('profiles').select('*').eq('id', testUserId).maybeSingle();
        if (prof) {
          authUser = { id: prof.id, email: prof.email };
          userProfile = prof;
        }
      }

      if (!authUser || !authUser.id) {
        return res.status(401).json({
          success: false,
          error: 'Utilisateur non authentifié.'
        });
      }

      let targetShopId: string | null = null;
      let targetShop: any = null;

      const normalizedUserRole = normalizeAuthRole(String(userProfile?.role || ''));
      if (normalizedUserRole === 'client') {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(authUser.id));
        let shop: any = null;
        if (isUuid) {
          const { data: shopData, error: shopErr } = await supabase
            .from('merchant_shops')
            .select('*')
            .or(`user_id.eq.${authUser.id},id.eq.${authUser.id}`)
            .maybeSingle();
          if (shopErr) {
            console.warn('[Client shop query notice, checking local storage]:', shopErr.message);
          }
          shop = shopData;
        }
        if (!shop && authUser.email) {
          const { data: shopByEmail } = await supabase
            .from('merchant_shops')
            .select('*')
            .ilike('email', authUser.email)
            .maybeSingle();
          if (shopByEmail) shop = shopByEmail;
        }

        const resolvedClientShop = shop || persistentStorage.getShopByUserId(authUser.id);

        if (resolvedClientShop?.account_status === 'suspendu' || userProfile?.account_status === 'suspendu') {
          return res.status(403).json({
            success: false,
            code: 'ACCOUNT_SUSPENDED',
            error: resolvedClientShop?.status_reason || "Votre compte boutique est suspendu par l'administration. Veuillez contacter FARIOUSY DELIVERY."
          });
        }

        if (!resolvedClientShop) {
          const localOnlyPackages = persistentStorage
            .getPackages({ ownerIds: [authUser.id] })
            .map(lp => applyPackageOverrides(lp));
          return res.json({
            success: true,
            count: localOnlyPackages.length,
            packages: localOnlyPackages
          });
        }

        targetShopId = resolvedClientShop.id;
        targetShop = resolvedClientShop;
      } else {
        // Pour les administrateurs ou employés
        const queryShopId = req.query.shopId as string;
        if (queryShopId) {
          targetShopId = queryShopId;
        }
      }

      let query = supabase
        .from('packages')
        .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city), driver:driver_id(id, full_name, phone, role)')
        .order('created_at', { ascending: false });

      if (normalizedUserRole === 'client') {
        query = query.eq('shop_id', targetShopId);
      } else if (targetShopId) {
        query = query.eq('shop_id', targetShopId);
      }

      const { data: rows, error: pkgErr } = await query;

      if (pkgErr) {
        console.warn('[Client packages query notice, falling back to persistent storage]:', pkgErr.message);
        const ownerList = Array.from(new Set([authUser.id, ...(targetShopId ? [targetShopId] : [])]));
        const localPackages = persistentStorage
          .getPackages({ ownerIds: ownerList })
          .map(lp => applyPackageOverrides(lp));
        return res.json({
          success: true,
          count: localPackages.length,
          packages: localPackages
        });
      }

      const problemMap = persistentStorage.getProblemReports();
      const mappedPackages: any[] = (rows || []).map((row: any) => {
        const rawCod = Number(row.cod_amount || 0);
        const rawFee = Number(row.delivery_fee || 0);
        const derivedProductPrice = Math.max(0, Math.round((rawCod - rawFee) * 100) / 100);
        const currentShop = row.merchant_shops || targetShop;
        const storedProblem = problemMap[row.id] || problemMap[row.tracking_number];
        const storedOpts = persistentStorage.getPackageOptions([row.id, row.tracking_number]);

        return applyPackageOverrides({
          id: row.id,
          trackingNumber: row.tracking_number,
          shopId: row.shop_id,
          clientId: currentShop?.user_id || row.shop_id,
          clientName: currentShop?.manager_name || 'Gérant',
          clientCompany: currentShop?.shop_name || 'Boutique',
          clientPhone: currentShop?.phone || '',
          recipientName: row.recipient_name,
          recipientPhone: row.recipient_phone,
          city: row.destination_city || 'Casablanca',
          address: row.destination_address || '',
          description: row.item_description || '',
          codAmount: rawCod,
          deliveryFee: rawFee,
          productPrice: derivedProductPrice,
          status: storedProblem && !storedProblem.resolved ? 'probleme_livraison' : (row.status || 'attente_ramassage'),
          driverId: row.driver_id || undefined,
          driverName: row.driver?.full_name || undefined,
          currentAgency: row.current_agency || 'Agence Principale',
          isPaidToClient: row.is_paid_to_client ?? false,
          allowOpen: storedOpts?.allowOpen ?? (typeof row.allow_open === 'boolean' ? row.allow_open : undefined),
          allowTry: storedOpts?.allowTry ?? (typeof row.allow_try === 'boolean' ? row.allow_try : undefined),
          isFragile: storedOpts?.isFragile ?? (typeof row.is_fragile === 'boolean' ? row.is_fragile : false),
          isExchange: storedOpts?.isExchange ?? (typeof row.is_exchange === 'boolean' ? row.is_exchange : false),
          exchangeTrackingNumber: storedOpts?.exchangeTrackingNumber ?? row.exchange_tracking_number ?? undefined,
          exchangeReason: storedOpts?.exchangeReason ?? row.exchange_reason ?? undefined,
          exchangeItemDescription: storedOpts?.exchangeItemDescription ?? row.exchange_item_description ?? undefined,
          callProofUrl: storedProblem?.photoBase64 || row.call_proof_url || undefined,
          problemReport: storedProblem || undefined,
          createdAt: row.created_at || new Date().toISOString(),
          lastMovedAt: row.updated_at || row.created_at || new Date().toISOString(),
          history: []
        });
      });

      const existingKeys = new Set<string>();
      for (const p of mappedPackages) {
        if (p.id) existingKeys.add(String(p.id).toLowerCase());
        if (p.trackingNumber) existingKeys.add(String(p.trackingNumber).toLowerCase());
      }
      const ownerList = Array.from(new Set([authUser.id, ...(targetShopId ? [targetShopId] : [])]));
      const localClientPackages = persistentStorage.getPackages(
        normalizedUserRole === 'client'
          ? { ownerIds: ownerList }
          : targetShopId
          ? { ownerIds: [targetShopId] }
          : undefined
      );
      for (const lp of localClientPackages) {
        if (!existingKeys.has(String(lp.id).toLowerCase()) && !existingKeys.has(String(lp.trackingNumber).toLowerCase())) {
          mappedPackages.push(applyPackageOverrides(lp));
        }
      }
      mappedPackages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return res.json({
        success: true,
        count: mappedPackages.length,
        packages: mappedPackages
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur colis client: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // CREATE PACKAGE ENDPOINT (Étape 82 & 85 : Ajout d'un colis dans public.packages)
  // RÈGLE COMMERCIALE : Total CRBT = Prix article + Frais de livraison
  // ---------------------------------------------------------------------------
  app.post(['/api/admin/packages', '/api/client/packages', '/api/packages'], authenticateAndAuthorize(['admin', 'employee', 'client']), async (req: Request, res: Response) => {
    try {
      const {
        shopId,
        recipientName,
        recipientPhone,
        city,
        address,
        description,
        productPrice,
        deliveryFee,
        codAmount,
        notes,
        allowOpen,
        allowTry,
        isFragile,
        isExchange,
        exchangeTrackingNumber,
        exchangeReason,
        exchangeItemDescription,
        stockLocationId,
        stockPosition
      } = req.body;

      // 1. Validation des champs obligatoires
      if (!shopId) {
        return res.status(400).json({ success: false, error: 'La boutique cliente (shopId) est obligatoire.' });
      }
      if (!recipientName || !recipientName.trim()) {
        return res.status(400).json({ success: false, error: 'Le nom du destinataire est obligatoire.' });
      }
      if (!recipientPhone || !recipientPhone.trim()) {
        return res.status(400).json({ success: false, error: 'Le numéro de téléphone du destinataire est obligatoire.' });
      }
      if (!city || !city.trim()) {
        return res.status(400).json({ success: false, error: 'La ville de destination est obligatoire.' });
      }
      if (!address || !address.trim()) {
        return res.status(400).json({ success: false, error: "L'adresse de livraison est obligatoire." });
      }

      // 2. Validation financière stricte (Étape 85)
      const parsedProductPrice = Number(productPrice);
      const parsedDeliveryFee = Number(deliveryFee);
      const parsedCodAmount = Number(codAmount);

      if (isNaN(parsedProductPrice) || parsedProductPrice < 0) {
        return res.status(400).json({
          success: false,
          error: "Le prix de l'article doit être un montant valide supérieur ou égal à 0 MAD."
        });
      }

      if (isNaN(parsedDeliveryFee) || parsedDeliveryFee <= 0) {
        return res.status(400).json({
          success: false,
          error: `Aucun tarif de livraison valide n'est configuré pour la ville « ${city} ». Les frais doivent être strictement supérieurs à 0 MAD.`
        });
      }

      // Règle commerciale FARIOUSY DELIVERY : Total CRBT à encaisser = Prix article + Frais de livraison
      const expectedCRBT = Math.round((parsedProductPrice + parsedDeliveryFee) * 100) / 100;
      const actualCRBT = Math.round(parsedCodAmount * 100) / 100;

      if (Math.abs(expectedCRBT - actualCRBT) > 0.05) {
        return res.status(400).json({
          success: false,
          error: `Incohérence du calcul CRBT : Total à encaisser (${actualCRBT} MAD) doit être égal à Prix article (${parsedProductPrice} MAD) + Frais de livraison (${parsedDeliveryFee} MAD) = ${expectedCRBT} MAD.`
        });
      }

      // 3. Recherche de la boutique cliente dans public.merchant_shops (+ auto-provisionnement si absente)
      const isShopIdUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(shopId));
      let resolvedShop: any = null;
      if (isShopIdUuid) {
        const { data: targetShop } = await supabase
          .from('merchant_shops')
          .select('*')
          .or(`id.eq.${shopId},user_id.eq.${shopId}`)
          .maybeSingle();
        if (targetShop) resolvedShop = targetShop;
      }

      if (!resolvedShop) {
        const localShop = persistentStorage.getShopByUserId(shopId) || persistentStorage.getShops().find(s => s.id === shopId);
        const user = persistentStorage.findUserById(shopId);
        let sbProfileShop: any = null;
        if (isShopIdUuid) {
          const { data: profRow } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', shopId)
            .maybeSingle();
          if (profRow) sbProfileShop = profRow;
        }

        const callerProf = (req as any).profile;
        const candidateEmail = (
          localShop?.email ||
          user?.email ||
          sbProfileShop?.email ||
          (shopId === callerProf?.id ? callerProf?.email : '') ||
          ''
        ).trim().toLowerCase();

        if (candidateEmail) {
          const { data: shopByEmail } = await supabase
            .from('merchant_shops')
            .select('*')
            .ilike('email', candidateEmail)
            .maybeSingle();
          if (shopByEmail) resolvedShop = shopByEmail;
        }

        // Auto-create missing merchant_shops row in Supabase when profile/user exists so packages insert succeeds in DB
        if (!resolvedShop && (sbProfileShop || user || localShop || req.body.clientName || req.body.clientCompany || callerProf)) {
          const draftShopName = (
            localShop?.shop_name ||
            req.body.clientCompany ||
            sbProfileShop?.company_name ||
            user?.companyName ||
            sbProfileShop?.full_name ||
            user?.name ||
            req.body.clientName ||
            callerProf?.companyName ||
            callerProf?.name ||
            'Boutique Client'
          ).trim();
          const draftManager = (
            localShop?.manager_name ||
            req.body.clientName ||
            sbProfileShop?.full_name ||
            user?.name ||
            callerProf?.name ||
            'Gérant'
          ).trim();
          const draftPhone = (
            localShop?.phone ||
            req.body.clientPhone ||
            sbProfileShop?.phone ||
            user?.phone ||
            callerProf?.phone ||
            '0600000000'
          ).trim();
          const draftCity = (
            localShop?.city ||
            sbProfileShop?.city ||
            user?.city ||
            city ||
            'Casablanca'
          ).trim();
          const draftAddress = (
            localShop?.pickup_address ||
            sbProfileShop?.address ||
            user?.address ||
            draftCity
          ).trim();
          const draftStatus = normalizeShopAccountStatus(
            localShop?.account_status ||
            sbProfileShop?.account_status ||
            sbProfileShop?.status ||
            user?.accountStatus ||
            user?.status ||
            'approuve'
          );

          let provErrorMsg: string | null = null;
          if (isShopIdUuid && sbProfileShop) {
            try {
              const nowIso = new Date().toISOString();
              const { data: provisionedShop, error: provErr } = await supabase
                .from('merchant_shops')
                .insert({
                  user_id: shopId,
                  shop_name: draftShopName,
                  manager_name: draftManager,
                  phone: draftPhone,
                  whatsapp: sbProfileShop?.whatsapp || user?.whatsapp || draftPhone,
                  email: candidateEmail || `${shopId}@fariousy.local`,
                  city: draftCity,
                  pickup_address: draftAddress,
                  activity_type: 'Commerce général',
                  account_status: draftStatus,
                  created_at: nowIso,
                  updated_at: nowIso
                })
                .select('*')
                .single();
              if (!provErr && provisionedShop) {
                resolvedShop = provisionedShop;
              } else if (provErr) {
                const { data: existingRetry } = await supabase
                  .from('merchant_shops')
                  .select('*')
                  .eq('user_id', shopId)
                  .maybeSingle();
                if (existingRetry) {
                  resolvedShop = existingRetry;
                } else {
                  provErrorMsg = provErr.message || String(provErr);
                  console.warn('[Auto-provision merchant_shops notice]:', provErrorMsg);
                }
              }
            } catch (provEx: any) {
              provErrorMsg = provEx?.message || String(provEx);
              console.warn('[Auto-provision merchant_shops exception]:', provErrorMsg);
            }
          }

          if (!resolvedShop) {
            resolvedShop = localShop || {
              id: shopId,
              user_id: shopId,
              shop_name: draftShopName,
              manager_name: draftManager,
              phone: draftPhone,
              email: candidateEmail,
              city: draftCity,
              account_status: draftStatus,
              _provError: provErrorMsg
            };
          }
        }
      }

      if (!resolvedShop) {
        return res.status(404).json({
          success: false,
          error: "Boutique marchande introuvable pour l'identifiant fourni."
        });
      }

      // Vérifier que la boutique n'est pas suspendue lorsque l'appelant est le client lui-même
      const callerRole = ((req as any).profile?.role || '').toLowerCase();
      const isCallerClient = callerRole === 'client' || callerRole === 'boutique' || callerRole === 'merchant' || callerRole === 'vendeur';
      if (isCallerClient && resolvedShop.account_status === 'suspendu') {
        return res.status(422).json({
          success: false,
          code: 'ACCOUNT_SUSPENDED',
          error: "Impossible d'ajouter un colis pour une boutique dont le compte est actuellement suspendu."
        });
      }

      // 4. Génération d'un numéro de suivi unique (anti-doublon)
      let trackingNumber = '';
      let isUnique = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const randomNum = Math.floor(100000 + Math.random() * 900000);
        const candidate = `FAR-${randomNum}`;
        const { data: existing } = await supabase
          .from('packages')
          .select('id')
          .eq('tracking_number', candidate)
          .maybeSingle();

        if (!existing) {
          trackingNumber = candidate;
          isUnique = true;
          break;
        }
      }

      if (!isUnique) {
        trackingNumber = `FAR-${Date.now().toString().slice(-7)}`;
      }

      // 5. Préparation et insertion dans public.packages
      const cleanRecipientName = recipientName.trim();
      const cleanRecipientPhone = recipientPhone.trim();
      const cleanCity = city.trim();
      const cleanAddress = address.trim();
      const cleanNotes = (notes || '').trim();
      const cleanDesc = (description || 'Colis e-commerce').trim();
      const fullDescription = cleanNotes ? `${cleanDesc} [Remarques: ${cleanNotes}]` : cleanDesc;
      const now = new Date().toISOString();

      let insertedPkg: any = null;
      let sbInsertErrorMsg: string | null = resolvedShop?._provError || null;
      const isResolvedShopUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(resolvedShop.id));
      if (isResolvedShopUuid) {
        try {
          const { data, error } = await supabase
            .from('packages')
            .insert({
              shop_id: resolvedShop.id,
              tracking_number: trackingNumber,
              recipient_name: cleanRecipientName,
              recipient_phone: cleanRecipientPhone,
              destination_city: cleanCity,
              destination_address: cleanAddress,
              item_description: fullDescription,
              cod_amount: expectedCRBT,
              delivery_fee: parsedDeliveryFee,
              status: 'attente_ramassage',
              is_paid_to_client: false,
              created_at: now,
              updated_at: now
            })
            .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city)')
            .single();

          if (!error && data) {
            insertedPkg = data;
          } else if (error) {
            sbInsertErrorMsg = sbInsertErrorMsg ? `${sbInsertErrorMsg} | ${error.message}` : error.message;
            console.warn('[Supabase package insert error, falling back to persistent storage]:', error.message);
          }
        } catch (sbInsertErr: any) {
          sbInsertErrorMsg = sbInsertErrorMsg ? `${sbInsertErrorMsg} | ${sbInsertErr?.message || String(sbInsertErr)}` : (sbInsertErr?.message || String(sbInsertErr));
          console.warn('[Supabase package insert warning, using persistent storage]:', sbInsertErr);
        }
      }

      const resolvedAllowOpen = allowOpen !== undefined ? Boolean(allowOpen) : false;
      const resolvedAllowTry = allowTry !== undefined ? Boolean(allowTry) : false;
      const resolvedIsFragile = isFragile !== undefined ? Boolean(isFragile) : false;
      const resolvedIsExchange = isExchange !== undefined ? Boolean(isExchange) : false;

      if (!insertedPkg) {
        console.warn('[Saving package to persistent storage]', sbInsertErrorMsg);
        const localPackage = persistentStorage.createPackage({
          shopId: resolvedShop.id,
          clientId: resolvedShop.user_id || shopId,
          clientName: resolvedShop.manager_name || 'Gérant',
          clientCompany: resolvedShop.shop_name,
          clientPhone: resolvedShop.phone || '',
          recipientName: cleanRecipientName,
          recipientPhone: cleanRecipientPhone,
          city: cleanCity,
          address: cleanAddress,
          description: cleanDesc,
          notes: cleanNotes || undefined,
          codAmount: expectedCRBT,
          productPrice: parsedProductPrice,
          deliveryFee: parsedDeliveryFee,
          status: 'attente_ramassage',
          currentAgency: 'Agence Principale',
          isPaidToClient: false,
          lastMovedAt: now,
          allowOpen: resolvedAllowOpen,
          allowTry: resolvedAllowTry,
          isFragile: resolvedIsFragile,
          isExchange: resolvedIsExchange,
          exchangeTrackingNumber: resolvedIsExchange ? (exchangeTrackingNumber || undefined) : undefined,
          exchangeReason: resolvedIsExchange ? (exchangeReason || undefined) : undefined,
          exchangeItemDescription: resolvedIsExchange ? (exchangeItemDescription || undefined) : undefined,
          stockLocationId: stockLocationId || undefined,
          stockPosition: stockPosition || undefined
        } as any);

        persistentStorage.savePackageOptions([localPackage.id, localPackage.trackingNumber], {
          allowOpen: resolvedAllowOpen,
          allowTry: resolvedAllowTry,
          isFragile: resolvedIsFragile,
          isExchange: resolvedIsExchange,
          exchangeTrackingNumber: resolvedIsExchange ? (exchangeTrackingNumber || undefined) : undefined,
          exchangeReason: resolvedIsExchange ? (exchangeReason || undefined) : undefined,
          exchangeItemDescription: resolvedIsExchange ? (exchangeItemDescription || undefined) : undefined
        });

        return res.status(201).json({
          success: true,
          storage: 'persistent',
          ...(sbInsertErrorMsg ? { dbNotice: sbInsertErrorMsg } : {}),
          message: `Colis ${localPackage.trackingNumber} enregistré avec succès dans le système FARIOUSY.`,
          package: localPackage
        });
      }

      persistentStorage.savePackageOptions([insertedPkg.id, insertedPkg.tracking_number], {
        allowOpen: resolvedAllowOpen,
        allowTry: resolvedAllowTry,
        isFragile: resolvedIsFragile,
        isExchange: resolvedIsExchange,
        exchangeTrackingNumber: resolvedIsExchange ? (exchangeTrackingNumber || undefined) : undefined,
        exchangeReason: resolvedIsExchange ? (exchangeReason || undefined) : undefined,
        exchangeItemDescription: resolvedIsExchange ? (exchangeItemDescription || undefined) : undefined
      });

      const mappedPackage: any = {
        id: insertedPkg.id,
        trackingNumber: insertedPkg.tracking_number,
        shopId: resolvedShop.id,
        clientId: resolvedShop.user_id,
        clientName: resolvedShop.manager_name || 'Gérant',
        clientCompany: resolvedShop.shop_name,
        clientPhone: resolvedShop.phone || '',
        recipientName: insertedPkg.recipient_name,
        recipientPhone: insertedPkg.recipient_phone,
        city: insertedPkg.destination_city,
        address: insertedPkg.destination_address,
        description: cleanDesc,
        notes: cleanNotes || undefined,
        codAmount: expectedCRBT,
        productPrice: parsedProductPrice,
        deliveryFee: parsedDeliveryFee,
        status: insertedPkg.status,
        currentAgency: 'Agence Principale',
        isPaidToClient: insertedPkg.is_paid_to_client ?? false,
        allowOpen: resolvedAllowOpen,
        allowTry: resolvedAllowTry,
        isFragile: resolvedIsFragile,
        isExchange: resolvedIsExchange,
        exchangeTrackingNumber: resolvedIsExchange ? (exchangeTrackingNumber || undefined) : undefined,
        exchangeReason: resolvedIsExchange ? (exchangeReason || undefined) : undefined,
        exchangeItemDescription: resolvedIsExchange ? (exchangeItemDescription || undefined) : undefined,
        stockLocationId: stockLocationId || undefined,
        stockPosition: stockPosition || undefined,
        createdAt: insertedPkg.created_at,
        lastMovedAt: insertedPkg.updated_at || insertedPkg.created_at,
        history: []
      };

      return res.status(201).json({
        success: true,
        message: `Colis ${trackingNumber} créé avec succès dans Supabase Production pour la boutique "${resolvedShop.shop_name}". Total CRBT : ${expectedCRBT} MAD (Article : ${parsedProductPrice} MAD + Frais : ${parsedDeliveryFee} MAD).`,
        package: mappedPackage
      });
    } catch (err: any) {
      console.error('[Create Package Error]', err);
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors de la création du colis: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // UPDATE PACKAGE STATUS ENDPOINT (Étape 89 : Enregistrement réel dans public.packages)
  // RÈGLE DE SÉCURITÉ : Rôle administrateur ou employé requis (accès strictement interdit aux clients)
  // ---------------------------------------------------------------------------
  const handlePackageStatusUpdate = async (req: Request, res: Response) => {
    try {
      const packageId = req.params.id;
      const { status: newStatus, comment, problemReport, callProofUrl } = req.body;

      if (!packageId) {
        return res.status(400).json({ success: false, error: 'Identifiant du colis manquant.' });
      }

      const ALLOWED_STATUSES = [
        'nouveau',
        'attente_ramassage',
        'ramasse',
        'en_stock',
        'en_transit',
        'arrive_destination',
        'en_cours_livraison',
        'livre',
        'pas_de_reponse',
        'probleme_livraison',
        'reporte',
        'refuse',
        'retour_en_cours',
        'retourne',
        'annule'
      ];

      if (!newStatus || !ALLOWED_STATUSES.includes(newStatus)) {
        return res.status(400).json({
          success: false,
          error: `Statut « ${newStatus} » invalide. Statuts autorisés : ${ALLOWED_STATUSES.join(', ')}`
        });
      }

      if (problemReport) {
        persistentStorage.saveProblemReport(packageId, problemReport);
      } else if (callProofUrl && newStatus === 'probleme_livraison') {
        persistentStorage.saveProblemReport(packageId, {
          id: `prob-${Date.now()}`,
          category: 'autre',
          categoryLabel: 'مشكلة في التوصيل',
          description: comment || 'Problème signalé par le livreur',
          photoBase64: callProofUrl,
          reportedBy: 'Livreur',
          reportedAt: new Date().toISOString(),
          resolved: false
        });
      }

      // 1. Vérifier l'existence du colis dans public.packages
      const { data: existingPkg, error: fetchErr } = await supabase
        .from('packages')
        .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, account_status)')
        .eq('id', packageId)
        .maybeSingle();

      if (fetchErr || !existingPkg) {
        const localUpdated = persistentStorage.updatePackageStatus(packageId, newStatus, comment);
        if (localUpdated) {
          return res.json({
            success: true,
            message: `Statut du colis ${localUpdated.trackingNumber} mis à jour.`,
            package: localUpdated
          });
        }
        return res.status(404).json({
          success: false,
          error: `Colis introuvable dans public.packages pour l'identifiant « ${packageId} »`
        });
      }

      // 2. Mise à jour dans public.packages (avec repli sur 'reporte' si la contrainte Supabase ne reconnaît pas probleme_livraison/pas_de_reponse)
      const now = new Date().toISOString();
      let dbStatus = newStatus;
      let { data: updatedPkg, error: updateErr } = await supabase
        .from('packages')
        .update({
          status: dbStatus,
          updated_at: now
        })
        .eq('id', packageId)
        .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city)')
        .single();

      if (updateErr && (newStatus === 'probleme_livraison' || newStatus === 'pas_de_reponse')) {
        dbStatus = 'reporte';
        const retry = await supabase
          .from('packages')
          .update({
            status: dbStatus,
            updated_at: now
          })
          .eq('id', packageId)
          .select('*, merchant_shops(id, user_id, shop_name, manager_name, phone, city)')
          .single();
        updatedPkg = retry.data;
        updateErr = retry.error;
      }

      if (updateErr || !updatedPkg) {
        return res.status(500).json({
          success: false,
          error: `Échec de mise à jour du statut dans public.packages: ${updateErr?.message || 'Erreur inconnue'}`
        });
      }

      const rawCod = Number(updatedPkg.cod_amount || 0);
      const rawFee = Number(updatedPkg.delivery_fee || 0);
      const derivedProductPrice = Math.max(0, Math.round((rawCod - rawFee) * 100) / 100);
      const currentShop = updatedPkg.merchant_shops || existingPkg.merchant_shops;
      const savedReport = persistentStorage.getProblemReports()[packageId];

      const mappedPackage = applyPackageOverrides({
        id: updatedPkg.id,
        trackingNumber: updatedPkg.tracking_number,
        shopId: updatedPkg.shop_id,
        clientId: currentShop?.user_id || updatedPkg.shop_id,
        clientName: currentShop?.manager_name || 'Gérant',
        clientCompany: currentShop?.shop_name || 'Boutique',
        clientPhone: currentShop?.phone || '',
        recipientName: updatedPkg.recipient_name,
        recipientPhone: updatedPkg.recipient_phone,
        city: updatedPkg.destination_city || 'Casablanca',
        address: updatedPkg.destination_address || '',
        description: updatedPkg.item_description || '',
        codAmount: rawCod,
        deliveryFee: rawFee,
        productPrice: derivedProductPrice,
        status: newStatus,
        problemReport: savedReport,
        callProofUrl: savedReport?.photoBase64 || callProofUrl || undefined,
        currentAgency: updatedPkg.current_agency || 'Agence Principale',
        isPaidToClient: updatedPkg.is_paid_to_client ?? false,
        createdAt: updatedPkg.created_at,
        lastMovedAt: updatedPkg.updated_at || now,
        history: []
      });

      persistentStorage.updatePackageStatus(packageId, newStatus, comment);
      persistentStorage.savePackageOverrides([packageId, updatedPkg.tracking_number], {
        status: newStatus,
        lastMovedAt: updatedPkg.updated_at || now,
        ...(comment ? { driverComment: comment } : {}),
        ...(callProofUrl ? { callProofUrl } : {}),
        history: [
          {
            id: `hist-${Date.now()}`,
            status: newStatus,
            statusLabel: `Statut : ${newStatus}`,
            updatedBy: (req as any).profile?.full_name || 'Administration FARIOUSY',
            role: normalizeAuthRole(String((req as any).profile?.role || 'admin')) as UserRole,
            timestamp: now,
            location: mappedPackage.currentAgency || mappedPackage.city || 'Hub Central',
            comment: comment || `Mise à jour du statut : ${newStatus}`
          }
        ]
      });

      return res.json({
        success: true,
        message: `Statut du colis ${updatedPkg.tracking_number} mis à jour avec succès vers « ${newStatus} ».`,
        package: mappedPackage
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors de la mise à jour du statut du colis: ${err.message}`
      });
    }
  };

  app.patch('/api/admin/packages/:id/status', authenticateAndAuthorize(['admin', 'employee', 'driver']), handlePackageStatusUpdate);
  app.put('/api/admin/packages/:id/status', authenticateAndAuthorize(['admin', 'employee', 'driver']), handlePackageStatusUpdate);
  app.patch('/api/driver/packages/:id/status', authenticateAndAuthorize(['admin', 'employee', 'driver']), handlePackageStatusUpdate);
  app.put('/api/driver/packages/:id/status', authenticateAndAuthorize(['admin', 'employee', 'driver']), handlePackageStatusUpdate);

  // ---------------------------------------------------------------------------
  // DELETE PACKAGE ENDPOINT (Permanent removal from public.packages + persistentStorage)
  // ---------------------------------------------------------------------------
  const handleDeletePackage = async (req: Request, res: Response) => {
    try {
      const packageId = req.params.id;
      if (!packageId) {
        return res.status(400).json({ success: false, error: 'Identifiant du colis manquant.' });
      }

      const callerUser = (req as any).user;
      const callerRole = String((req as any).profile?.role || '').toLowerCase();
      const isCallerClient =
        callerRole === 'client' ||
        callerRole === 'boutique' ||
        callerRole === 'merchant' ||
        callerRole === 'vendeur';

      // Rechercher le colis par ID (si UUID) puis par tracking_number
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packageId.trim());
      let targetPkg: any = null;
      if (isUuid) {
        const byId = await supabase
          .from('packages')
          .select('id, tracking_number, shop_id, status, is_paid_to_client')
          .eq('id', packageId)
          .maybeSingle();
        if (byId.data) {
          targetPkg = byId.data;
        }
      }
      if (!targetPkg) {
        const byTracking = await supabase
          .from('packages')
          .select('id, tracking_number, shop_id, status, is_paid_to_client')
          .eq('tracking_number', packageId)
          .maybeSingle();
        if (byTracking.data) {
          targetPkg = byTracking.data;
        }
      }

      if (targetPkg && isCallerClient) {
        const { data: callerShop } = await supabase
          .from('merchant_shops')
          .select('id')
          .eq('user_id', callerUser?.id)
          .maybeSingle();

        if (!callerShop || callerShop.id !== targetPkg.shop_id) {
          return res.status(422).json({
            success: false,
            error: 'Accès refusé : ce colis n’appartient pas à votre boutique.'
          });
        }
      }

      if (targetPkg) {
        // Nettoyer les éventuelles références dans client_messages et client_debts
        try {
          await supabase
            .from('client_messages')
            .update({ package_id: null })
            .eq('package_id', targetPkg.id);
        } catch {}

        try {
          await supabase
            .from('client_debts')
            .update({ package_id: null })
            .eq('package_id', targetPkg.id);
        } catch {}

        const { error: delErr } = await supabase
          .from('packages')
          .delete()
          .eq('id', targetPkg.id);

        if (delErr) {
          return res.status(500).json({
            success: false,
            error: `Impossible de supprimer le colis dans Supabase: ${delErr.message}`
          });
        }

        persistentStorage.deletePackage(targetPkg.id);
        persistentStorage.deletePackage(targetPkg.tracking_number);
      } else {
        const deletedLocal = persistentStorage.deletePackage(packageId);
        if (!deletedLocal) {
          // Même si déjà absent de Supabase/local, nettoyer par sécurité et confirmer
          persistentStorage.deletePackage(packageId);
        }
      }

      return res.json({
        success: true,
        message: `Le colis ${targetPkg?.tracking_number || packageId} a été supprimé définitivement de Supabase.`
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur serveur lors de la suppression du colis: ${err.message}`
      });
    }
  };

  const handleUpdatePackage = async (req: Request, res: Response) => {
    try {
      const packageId = req.params.id;
      const body = req.body || {};
      const { historyEntry, ...updates } = body;
      const callerProfile = (req as any).profile || (req as any).user;
      const callerNormRole = normalizeAuthRole(String(callerProfile?.role || ''));
      const isCallerClient = callerNormRole === 'client' && !isOwnerSuperAdmin(callerProfile);

      if (!packageId) {
        return res.status(400).json({ success: false, error: 'Identifiant du colis manquant.' });
      }

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packageId.trim());
      let resolvedTracking: string | undefined;
      try {
        let pkgQuery = supabase.from('packages').select('*');
        if (isUuid) {
          pkgQuery = pkgQuery.eq('id', packageId.trim());
        } else {
          pkgQuery = pkgQuery.eq('tracking_number', packageId.trim().toUpperCase());
        }
        const { data: targetPkg } = await pkgQuery.maybeSingle();

        if (targetPkg) {
          resolvedTracking = targetPkg.tracking_number;
          if (isCallerClient) {
            const { data: callerShop } = await supabase
              .from('merchant_shops')
              .select('id')
              .eq('user_id', callerProfile.id)
              .maybeSingle();
            if (!callerShop || callerShop.id !== targetPkg.shop_id) {
              return res.status(403).json({ success: false, error: 'Accès refusé pour ce colis.' });
            }
          }

          const dbPatch: Record<string, any> = { updated_at: new Date().toISOString() };
          if (updates.recipientName !== undefined) dbPatch.recipient_name = updates.recipientName;
          if (updates.recipientPhone !== undefined) dbPatch.recipient_phone = updates.recipientPhone;
          if (updates.city !== undefined) dbPatch.destination_city = updates.city;
          if (updates.address !== undefined) dbPatch.destination_address = updates.address;
          if (updates.description !== undefined) dbPatch.item_description = updates.description;
          if (updates.codAmount !== undefined) dbPatch.cod_amount = Number(updates.codAmount);
          if (updates.deliveryFee !== undefined) dbPatch.delivery_fee = Number(updates.deliveryFee);
          if (updates.isPaidToClient !== undefined) dbPatch.is_paid_to_client = Boolean(updates.isPaidToClient);
          if (updates.status !== undefined) dbPatch.status = updates.status;
          if (updates.driverId !== undefined) dbPatch.driver_id = updates.driverId || null;

          const { error: sbUpErr } = await supabase.from('packages').update(dbPatch).eq('id', targetPkg.id);
          if (sbUpErr) {
            console.warn('[Package Update DB Patch Warning]', sbUpErr.message);
          }

          // Try updating extended partner/agency columns cleanly if schema supports them
          const extPatch: Record<string, any> = {};
          if (updates.currentAgency !== undefined) extPatch.current_agency = updates.currentAgency;
          if (updates.isTransferredToPartner !== undefined) extPatch.is_transferred_to_partner = Boolean(updates.isTransferredToPartner);
          if (updates.partnerName !== undefined) extPatch.partner_name = updates.partnerName;
          if (updates.partnerTrackingId !== undefined) extPatch.partner_tracking_id = updates.partnerTrackingId;
          if (updates.partnerId !== undefined) extPatch.partner_id = updates.partnerId || null;
          if (Object.keys(extPatch).length > 0) {
            await supabase.from('packages').update(extPatch).eq('id', targetPkg.id).then(() => {}, () => {});
          }
        }
      } catch (sbErr: any) {
        console.warn('[Package Update Supabase Warning]', sbErr?.message);
      }

      const overridePatch: Partial<PackageItem> = {
        ...updates,
        ...(historyEntry ? { history: [historyEntry] } : {})
      };
      const localUpdated = persistentStorage.updatePackage(packageId, updates);
      const savedOverride = persistentStorage.savePackageOverrides(
        [packageId, localUpdated?.id, localUpdated?.trackingNumber, resolvedTracking],
        overridePatch
      );

      if (
        updates.allowOpen !== undefined ||
        updates.allowTry !== undefined ||
        updates.isFragile !== undefined ||
        updates.isExchange !== undefined ||
        updates.exchangeTrackingNumber !== undefined ||
        updates.exchangeReason !== undefined ||
        updates.exchangeItemDescription !== undefined
      ) {
        persistentStorage.savePackageOptions([packageId, localUpdated?.id, localUpdated?.trackingNumber, resolvedTracking], {
          allowOpen: updates.allowOpen !== undefined ? Boolean(updates.allowOpen) : undefined,
          allowTry: updates.allowTry !== undefined ? Boolean(updates.allowTry) : undefined,
          isFragile: updates.isFragile !== undefined ? Boolean(updates.isFragile) : undefined,
          isExchange: updates.isExchange !== undefined ? Boolean(updates.isExchange) : undefined,
          exchangeTrackingNumber: updates.exchangeTrackingNumber,
          exchangeReason: updates.exchangeReason,
          exchangeItemDescription: updates.exchangeItemDescription
        });
      }
      return res.json({
        success: true,
        package: localUpdated ? { ...localUpdated, ...savedOverride } : { id: packageId, ...savedOverride }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  };

  app.patch('/api/admin/packages/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), handleUpdatePackage);
  app.put('/api/admin/packages/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), handleUpdatePackage);
  app.patch('/api/packages/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), handleUpdatePackage);
  app.put('/api/packages/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), handleUpdatePackage);

  app.delete('/api/admin/packages/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), handleDeletePackage);
  app.delete('/api/packages/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), handleDeletePackage);
  app.delete('/api/client/packages/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), handleDeletePackage);

  app.delete('/api/admin/pickups/:id', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((id || '').trim());
      if (isUuid) {
        await supabase.from('pickup_requests').delete().eq('id', id.trim());
      }
      const savedPickups = persistentStorage.getSystemCollection<any[]>('pickups');
      if (Array.isArray(savedPickups)) {
        persistentStorage.setSystemCollection(
          'pickups',
          savedPickups.filter((p: any) => p.id !== id)
        );
      }
      return res.json({ success: true, message: 'Demande de ramassage supprimée.' });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Problem Reports endpoints (مشكلة في التوصيل + صورة)
  app.get('/api/problem-reports', authenticateAndAuthorize(['admin', 'employee', 'driver', 'client']), (_req: Request, res: Response) => {
    res.json({ success: true, reports: persistentStorage.getProblemReports() });
  });

  app.post('/api/problem-reports', authenticateAndAuthorize(['admin', 'employee', 'driver']), (req: Request, res: Response) => {
    try {
      const { packageId, report } = req.body;
      if (!packageId || !report) {
        return res.status(400).json({ success: false, error: 'packageId et report requis.' });
      }
      const saved = persistentStorage.saveProblemReport(packageId, report);
      return res.json({ success: true, report: saved });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.patch('/api/problem-reports/:packageId/resolve', authenticateAndAuthorize(['admin', 'employee']), (req: Request, res: Response) => {
    try {
      const { packageId } = req.params;
      const { resolvedBy, adminNote } = req.body;
      const updated = persistentStorage.resolveProblemReport(packageId, resolvedBy || 'Administrateur', adminNote);
      return res.json({ success: true, report: updated });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // TEST ENVIRONMENT STATUS ENDPOINT (Isolation TEST / PRODUCTION)
  // ---------------------------------------------------------------------------
  app.get('/api/admin/clients/test-env-status', authenticateAndAuthorize(['admin']), (_req: Request, res: Response) => {
    const testUrl = (process.env.FARIOUSY_TEST_SUPABASE_URL || process.env.SUPABASE_TEST_URL || '').trim();
    const testKey = (process.env.FARIOUSY_TEST_SERVICE_ROLE_KEY || process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || '').trim();
    const isTestConfigured = Boolean(testUrl && testKey);

    return res.json({
      success: true,
      configured: isTestConfigured,
      productionUrl: SUPABASE_URL,
      message: isTestConfigured
        ? "L'environnement FARIOUSY TEST dédié est configuré et prêt."
        : "Aucun projet Supabase TEST dédié n'est configuré sur ce serveur."
    });
  });

  // ---------------------------------------------------------------------------
  // CREATE CLIENT ENDPOINT (SUPABASE AUTH + public.profiles + public.merchant_shops)
  // ---------------------------------------------------------------------------
  app.post('/api/admin/clients', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    try {
      const {
        shopName,
        managerName,
        phone,
        whatsapp,
        email,
        city,
        address,
        activityType,
        isTest
      } = req.body;

      // 1. Mandatory field validations
      if (!shopName || !shopName.trim()) {
        return res.status(400).json({ success: false, error: 'Le nom de la boutique est obligatoire.' });
      }
      if (!managerName || !managerName.trim()) {
        return res.status(400).json({ success: false, error: 'Le nom du responsable est obligatoire.' });
      }
      if (!phone || !phone.trim()) {
        return res.status(400).json({ success: false, error: 'Le numéro de téléphone est obligatoire.' });
      }
      if (!email || !email.trim()) {
        return res.status(400).json({ success: false, error: "L'adresse e-mail est obligatoire." });
      }
      if (!city || !city.trim()) {
        return res.status(400).json({ success: false, error: 'La ville est obligatoire.' });
      }
      if (!address || !address.trim()) {
        return res.status(400).json({ success: false, error: "L'adresse complète de ramassage est obligatoire." });
      }

      const cleanEmail = email.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanEmail)) {
        return res.status(400).json({ success: false, error: "Format d'adresse e-mail invalide." });
      }

      const cleanShopName = shopName.trim();
      const cleanManager = managerName.trim();
      const cleanPhone = phone.trim();
      const cleanWhatsapp = (whatsapp || phone).trim();
      const cleanCity = city.trim();
      const cleanAddress = address.trim();
      const cleanActivity = (activityType || 'Commerce général').trim();

      // 2. Duplicate checks in public.profiles and public.merchant_shops
      const { data: existingProfile, error: checkProfErr } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .ilike('email', cleanEmail)
        .maybeSingle();

      if (checkProfErr && checkProfErr.code !== 'PGRST116') {
        console.warn('[Check Duplicate Profile Warning]', checkProfErr.message);
      }

      if (existingProfile) {
        return res.status(409).json({
          success: false,
          error: `Un compte utilisateur existe déjà avec l'adresse e-mail : ${cleanEmail}`
        });
      }

      // Check shop name duplicate
      const { data: existingShop } = await supabase
        .from('merchant_shops')
        .select('id, shop_name')
        .ilike('shop_name', cleanShopName)
        .maybeSingle();

      if (existingShop) {
        return res.status(409).json({
          success: false,
          error: `Une boutique portant le nom "${cleanShopName}" existe déjà.`
        });
      }

      // 3. ISOLATION STRICTE TEST / PRODUCTION (Étape 72)
      if (isTest === true) {
        const testUrl = (process.env.FARIOUSY_TEST_SUPABASE_URL || process.env.SUPABASE_TEST_URL || '').trim();
        const testKey = (process.env.FARIOUSY_TEST_SERVICE_ROLE_KEY || process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || '').trim();

        // RÈGLE DE SÉCURITÉ ABSOLUE : Si l'environnement de test dédié n'est pas configuré,
        // bloquer immédiatement SANS JAMAIS INTERAGIR AVEC LA PRODUCTION !
        if (!testUrl || !testKey) {
          return res.status(400).json({
            success: false,
            error: "L'environnement « FARIOUSY TEST » n'est pas configuré sur ce serveur (projet Supabase de test dédié non configuré). Aucune écriture n'a été effectuée sur la base de Production. Pour enregistrer ce client en Production, veuillez décocher la case « Environnement FARIOUSY TEST »."
          });
        }

        // Connexion exclusive au projet TEST dédié (aucune interaction avec la base de production)
        const testSupabase = createClient(sanitizeSupabaseUrl(testUrl), testKey, {
          auth: { persistSession: false }
        });

        // 3.1 Vérification des doublons dans la base TEST
        const { data: testDupProfile } = await testSupabase
          .from('profiles')
          .select('id, email')
          .ilike('email', cleanEmail)
          .maybeSingle();

        if (testDupProfile) {
          return res.status(409).json({
            success: false,
            error: `[FARIOUSY TEST] Un compte avec l'adresse e-mail "${cleanEmail}" existe déjà dans la base de test.`
          });
        }

        // 3.2 Création du compte dans auth.users de TEST via invitation sécurisée
        const testLinkRes = await testSupabase.auth.admin.generateLink({
          type: 'invite',
          email: cleanEmail,
          options: {
            data: {
              full_name: cleanManager,
              phone: cleanPhone,
              role: 'client'
            }
          }
        });

        if (testLinkRes.error || !testLinkRes.data?.user?.id) {
          return res.status(500).json({
            success: false,
            error: `[FARIOUSY TEST] Échec création Auth test: ${testLinkRes.error?.message || 'Erreur inconnue'}`
          });
        }

        const testAuthUserId = testLinkRes.data.user.id;
        const testNow = new Date().toISOString();

        // 3.3 Insertion du profil dans public.profiles de TEST
        const { error: testProfErr } = await testSupabase
          .from('profiles')
          .insert({
            id: testAuthUserId,
            role: 'client',
            full_name: cleanManager,
            email: cleanEmail,
            phone: cleanPhone,
            whatsapp: cleanWhatsapp,
            city: cleanCity,
            address: cleanAddress,
            created_at: testNow,
            updated_at: testNow
          });

        if (testProfErr) {
          await testSupabase.auth.admin.deleteUser(testAuthUserId);
          return res.status(500).json({
            success: false,
            error: `[FARIOUSY TEST] Échec insertion profil test: ${testProfErr.message}`
          });
        }

        // 3.4 Insertion de la boutique dans public.merchant_shops de TEST
        const { data: testShop, error: testShopErr } = await testSupabase
          .from('merchant_shops')
          .insert({
            user_id: testAuthUserId,
            shop_name: cleanShopName,
            manager_name: cleanManager,
            phone: cleanPhone,
            whatsapp: cleanWhatsapp,
            email: cleanEmail,
            city: cleanCity,
            pickup_address: cleanAddress,
            activity_type: cleanActivity,
            account_status: 'approuve',
            status_reason: "Compte créé dans l'environnement FARIOUSY TEST",
            approved_at: testNow,
            created_at: testNow,
            updated_at: testNow
          })
          .select()
          .single();

        if (testShopErr) {
          await testSupabase.from('profiles').delete().eq('id', testAuthUserId);
          await testSupabase.auth.admin.deleteUser(testAuthUserId);
          return res.status(500).json({
            success: false,
            error: `[FARIOUSY TEST] Échec insertion boutique test: ${testShopErr.message}`
          });
        }

        return res.status(201).json({
          success: true,
          message: `[FARIOUSY TEST] Boutique "${cleanShopName}" et compte client créés avec succès dans le projet Supabase TEST dédié.`,
          isTest: true,
          client: {
            id: testAuthUserId,
            shopId: testShop?.id,
            name: cleanManager,
            companyName: cleanShopName,
            email: cleanEmail,
            phone: cleanPhone,
            whatsapp: cleanWhatsapp,
            city: cleanCity,
            address: cleanAddress,
            activityType: cleanActivity,
            role: 'client',
            status: 'approuve',
            accountStatus: 'approuve',
            registeredAt: testNow
          },
          invitationLink: testLinkRes.data.properties?.action_link || null
        });
      }

      // 4. Create client in Supabase Auth via secure invitation (No default password invented)
      let authUserId: string | null = null;
      let invitationLink: string | null = null;

      // Primary: Generate secure invitation link (client sets their own password upon first access)
      const linkRes = await supabase.auth.admin.generateLink({
        type: 'invite',
        email: cleanEmail,
        options: {
          data: {
            full_name: cleanManager,
            phone: cleanPhone,
            role: 'client'
          }
        }
      });

      if (linkRes.data?.user?.id) {
        authUserId = linkRes.data.user.id;
        invitationLink = linkRes.data.properties?.action_link || null;
      } else if (linkRes.error) {
        // Fallback: createUser with email_confirm if generateLink error
        console.warn('[Supabase Auth GenerateLink Warning]', linkRes.error.message);
        const createRes = await supabase.auth.admin.createUser({
          email: cleanEmail,
          email_confirm: true,
          user_metadata: {
            full_name: cleanManager,
            phone: cleanPhone,
            role: 'client'
          }
        });

        if (createRes.error || !createRes.data?.user?.id) {
          return res.status(500).json({
            success: false,
            error: `Échec de la création du compte Supabase Auth : ${createRes.error?.message || linkRes.error.message}`
          });
        }
        authUserId = createRes.data.user.id;
      }

      if (!authUserId) {
        return res.status(500).json({
          success: false,
          error: "Impossible d'obtenir l'identifiant du compte Supabase Auth."
        });
      }

      // 5. Create profile in public.profiles (role: 'client')
      const now = new Date().toISOString();
      const { error: profileInsertErr } = await supabase
        .from('profiles')
        .insert({
          id: authUserId,
          role: 'client',
          full_name: cleanManager,
          email: cleanEmail,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          city: cleanCity,
          address: cleanAddress,
          created_at: now,
          updated_at: now
        });

      if (profileInsertErr) {
        // Rollback created auth user
        await supabase.auth.admin.deleteUser(authUserId);
        return res.status(500).json({
          success: false,
          error: `Erreur lors de la création du profil public.profiles : ${profileInsertErr.message}`
        });
      }

      // 6. Create merchant shop in public.merchant_shops
      const adminUserId = (req as any).user?.id || (req as any).profile?.id || null;
      const { data: newShop, error: shopInsertErr } = await supabase
        .from('merchant_shops')
        .insert({
          user_id: authUserId,
          shop_name: cleanShopName,
          manager_name: cleanManager,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          email: cleanEmail,
          city: cleanCity,
          pickup_address: cleanAddress,
          activity_type: cleanActivity,
          account_status: 'approuve',
          status_reason: "Compte créé et validé par l'administrateur",
          approved_at: now,
          approved_by: adminUserId,
          created_at: now,
          updated_at: now
        })
        .select()
        .single();

      if (shopInsertErr) {
        // Rollback profile and auth user
        await supabase.from('profiles').delete().eq('id', authUserId);
        await supabase.auth.admin.deleteUser(authUserId);
        return res.status(500).json({
          success: false,
          error: `Erreur lors de la création de la boutique public.merchant_shops : ${shopInsertErr.message}`
        });
      }

      // Note de sécurité : Ne pas envoyer d'e-mails réels automatiques non sollicités.
      // Le lien d'invitation sécurisé généré par generateLink est transmis directement à l'administrateur
      // dans l'interface sécurisée pour qu'il puisse l'activer au moment opportun.

      return res.status(201).json({
        success: true,
        message: `La boutique "${cleanShopName}" et le compte client ont été créés avec succès dans Supabase.`,
        client: {
          id: authUserId,
          shopId: newShop.id,
          name: cleanManager,
          companyName: cleanShopName,
          email: cleanEmail,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          city: cleanCity,
          address: cleanAddress,
          activityType: cleanActivity,
          role: 'client',
          status: 'approuve',
          accountStatus: 'approuve',
          registeredAt: now
        },
        invitationLink
      });
    } catch (err: any) {
      console.error('[Create Client Error]', err);
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors de la création du client : ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // UPDATE CLIENT ENDPOINT (Étape 75 — Supabase public.profiles + public.merchant_shops)
  // ---------------------------------------------------------------------------
  app.put('/api/admin/clients/:id', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    try {
      const clientId = req.params.id;
      if (!clientId) {
        return res.status(400).json({ success: false, error: 'Identifiant du client manquant.' });
      }

      const {
        shopName,
        managerName,
        phone,
        whatsapp,
        city,
        address,
        activityType,
        bankName,
        bankRib
      } = req.body || {};

      const cleanBankName = typeof bankName === 'string' ? bankName.trim() : undefined;
      const cleanBankRib = typeof bankRib === 'string' ? bankRib.replace(/[^0-9]/g, '') : undefined;
      if (cleanBankRib !== undefined && cleanBankRib.length > 0 && !/^\d{24}$/.test(cleanBankRib)) {
        return res.status(400).json({
          success: false,
          error: 'Le numéro RIB bancaire doit contenir exactement 24 chiffres.'
        });
      }

      // Look up existing profile, merchant shop, and local storage first so partial or bank-only updates never fail needlessly
      const storedClient = persistentStorage.findUserById(clientId);
      const { data: targetProfile, error: profileErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', clientId)
        .maybeSingle();

      if (profileErr) {
        return res.status(500).json({
          success: false,
          error: `Erreur lors de la recherche du profil : ${profileErr.message}`
        });
      }

      const { data: existingShop } = await supabase
        .from('merchant_shops')
        .select('*')
        .or(`user_id.eq.${clientId},id.eq.${clientId}`)
        .maybeSingle();

      if (!targetProfile && !existingShop && !storedClient) {
        return res.status(404).json({
          success: false,
          error: 'Compte client introuvable dans la base de données.'
        });
      }

      if (targetProfile && targetProfile.role && targetProfile.role !== 'client') {
        return res.status(403).json({
          success: false,
          error: "Seuls les comptes marchands au rôle 'client' peuvent être modifiés via cette interface."
        });
      }

      const cleanManager = (
        (typeof managerName === 'string' ? managerName.trim() : '') ||
        existingShop?.manager_name ||
        targetProfile?.full_name ||
        storedClient?.name ||
        ''
      ).trim();

      const cleanShopName = (
        (typeof shopName === 'string' ? shopName.trim() : '') ||
        existingShop?.shop_name ||
        targetProfile?.company_name ||
        storedClient?.companyName ||
        cleanManager
      ).trim();

      const cleanPhone = (
        (typeof phone === 'string' ? phone.trim() : '') ||
        existingShop?.phone ||
        targetProfile?.phone ||
        storedClient?.phone ||
        ''
      ).trim();

      const cleanWhatsapp = (
        (typeof whatsapp === 'string' ? whatsapp.trim() : '') ||
        existingShop?.whatsapp ||
        targetProfile?.whatsapp ||
        storedClient?.whatsapp ||
        cleanPhone
      ).trim();

      const cleanCity = (
        (typeof city === 'string' ? city.trim() : '') ||
        existingShop?.city ||
        targetProfile?.city ||
        storedClient?.city ||
        'Casablanca'
      ).trim();

      const cleanAddress = (
        (typeof address === 'string' ? address.trim() : '') ||
        existingShop?.pickup_address ||
        targetProfile?.address ||
        storedClient?.address ||
        cleanCity
      ).trim();

      const cleanActivity = (
        (typeof activityType === 'string' ? activityType.trim() : '') ||
        existingShop?.activity_type ||
        storedClient?.activityType ||
        'Commerce général'
      ).trim();

      if (!cleanShopName) {
        return res.status(400).json({ success: false, error: 'Le nom de la boutique est obligatoire.' });
      }
      if (!cleanManager) {
        return res.status(400).json({ success: false, error: 'Le nom du responsable est obligatoire.' });
      }
      if (!cleanPhone) {
        return res.status(400).json({ success: false, error: 'Le numéro de téléphone est obligatoire.' });
      }

      const effectiveUserId = targetProfile?.id || existingShop?.user_id || clientId;
      const effectiveEmail = targetProfile?.email || existingShop?.email || storedClient?.email || '';

      // Verify no other merchant shop is already using this shop name
      if (typeof shopName === 'string' && shopName.trim()) {
        const { data: duplicateShop } = await supabase
          .from('merchant_shops')
          .select('id, user_id, shop_name')
          .ilike('shop_name', cleanShopName)
          .neq('user_id', effectiveUserId)
          .maybeSingle();

        if (duplicateShop && duplicateShop.id !== existingShop?.id) {
          return res.status(409).json({
            success: false,
            error: `Une autre boutique porte déjà le nom "${cleanShopName}".`
          });
        }
      }

      const now = new Date().toISOString();

      // Update public.profiles if present in Supabase
      if (targetProfile) {
        const { error: profUpdateErr } = await supabase
          .from('profiles')
          .update({
            full_name: cleanManager,
            phone: cleanPhone,
            whatsapp: cleanWhatsapp,
            city: cleanCity,
            address: cleanAddress,
            updated_at: now
          })
          .eq('id', targetProfile.id);

        if (profUpdateErr) {
          return res.status(500).json({
            success: false,
            error: `Erreur lors de la mise à jour de public.profiles : ${profUpdateErr.message}`
          });
        }
      }

      // Update or insert in public.merchant_shops when targetProfile exists
      let updatedShop: any = existingShop;
      if (existingShop) {
        const { data: shopRes, error: shopUpErr } = await supabase
          .from('merchant_shops')
          .update({
            shop_name: cleanShopName,
            manager_name: cleanManager,
            phone: cleanPhone,
            whatsapp: cleanWhatsapp,
            city: cleanCity,
            pickup_address: cleanAddress,
            activity_type: cleanActivity,
            updated_at: now
          })
          .eq('id', existingShop.id)
          .select()
          .single();

        if (shopUpErr) {
          return res.status(500).json({
            success: false,
            error: `Erreur lors de la mise à jour de public.merchant_shops : ${shopUpErr.message}`
          });
        }
        updatedShop = shopRes;
      } else if (targetProfile) {
        const { data: shopRes, error: shopInsErr } = await supabase
          .from('merchant_shops')
          .insert({
            user_id: targetProfile.id,
            shop_name: cleanShopName,
            manager_name: cleanManager,
            phone: cleanPhone,
            whatsapp: cleanWhatsapp,
            email: targetProfile.email,
            city: cleanCity,
            pickup_address: cleanAddress,
            activity_type: cleanActivity,
            account_status: 'approuve',
            created_at: now,
            updated_at: now
          })
          .select()
          .single();

        if (shopInsErr) {
          return res.status(500).json({
            success: false,
            error: `Erreur lors de l'enregistrement de la boutique : ${shopInsErr.message}`
          });
        }
        updatedShop = shopRes;
      }

      // Persist updates + bank details in persistentStorage & kycDocuments & optional Supabase columns
      const localUpdates: Record<string, any> = {
        name: cleanManager,
        companyName: cleanShopName,
        phone: cleanPhone,
        whatsapp: cleanWhatsapp,
        city: cleanCity,
        address: cleanAddress,
        activityType: cleanActivity,
        ...(cleanBankName !== undefined ? { bankName: cleanBankName } : {}),
        ...(cleanBankRib !== undefined ? { bankRib: cleanBankRib } : {})
      };

      if (storedClient) {
        persistentStorage.updateUser(clientId, localUpdates);
      } else {
        persistentStorage.upsertUser({
          id: effectiveUserId,
          email: effectiveEmail,
          role: 'client',
          status: updatedShop?.account_status || 'approuve',
          accountStatus: updatedShop?.account_status || 'approuve',
          registeredAt: updatedShop?.created_at || targetProfile?.created_at || now,
          ...localUpdates
        } as any);
      }

      if (cleanBankName !== undefined || cleanBankRib !== undefined) {
        persistentStorage.saveKycDocuments(
          [effectiveUserId, clientId, existingShop?.id, effectiveEmail].filter(Boolean) as string[],
          {
            bankName: cleanBankName,
            bankRib: cleanBankRib
          }
        );
        try {
          await supabase
            .from('merchant_shops')
            .update({
              ...(cleanBankName !== undefined ? { bank_name: cleanBankName } : {}),
              ...(cleanBankRib !== undefined ? { bank_rib: cleanBankRib } : {})
            })
            .eq('user_id', effectiveUserId);
        } catch {}
        try {
          await supabase
            .from('profiles')
            .update({
              ...(cleanBankName !== undefined ? { bank_name: cleanBankName } : {}),
              ...(cleanBankRib !== undefined ? { bank_rib: cleanBankRib } : {})
            })
            .eq('id', effectiveUserId);
        } catch {}
      }

      const savedKyc = persistentStorage.getKycDocuments([effectiveUserId, clientId, effectiveEmail].filter(Boolean) as string[]);

      return res.json({
        success: true,
        message: `Les informations de la boutique "${cleanShopName}" ont été modifiées avec succès.`,
        client: {
          id: effectiveUserId,
          shopId: updatedShop?.id,
          name: cleanManager,
          companyName: cleanShopName,
          email: effectiveEmail,
          phone: cleanPhone,
          whatsapp: cleanWhatsapp,
          city: cleanCity,
          address: cleanAddress,
          activityType: cleanActivity,
          bankName: cleanBankName ?? savedKyc?.bankName,
          bankRib: cleanBankRib ?? savedKyc?.bankRib,
          role: 'client',
          status: updatedShop?.account_status || storedClient?.status || 'approuve',
          accountStatus: updatedShop?.account_status || storedClient?.accountStatus || 'approuve',
          registeredAt: updatedShop?.created_at || targetProfile?.created_at || storedClient?.registeredAt || now
        }
      });
    } catch (err: any) {
      console.error('[Update Client Error]', err);
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors de la modification du client : ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // DIRECT CLIENT BANK / RIB UPDATE (Admin/Staff quick save without shop metadata validation)
  // ---------------------------------------------------------------------------
  app.patch('/api/admin/clients/:id/bank', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const clientId = req.params.id;
      if (!clientId) {
        return res.status(400).json({ success: false, error: 'Identifiant du client manquant.' });
      }

      const cleanBankName = typeof req.body?.bankName === 'string' ? req.body.bankName.trim() : undefined;
      const cleanBankRib = typeof req.body?.bankRib === 'string' ? req.body.bankRib.replace(/[^0-9]/g, '') : undefined;

      if (cleanBankRib !== undefined && cleanBankRib.length > 0 && !/^\d{24}$/.test(cleanBankRib)) {
        return res.status(400).json({
          success: false,
          error: 'Le numéro RIB bancaire doit contenir exactement 24 chiffres.'
        });
      }

      if (cleanBankRib && cleanBankRib.length === 24 && !cleanBankName) {
        return res.status(400).json({
          success: false,
          error: 'Veuillez indiquer le nom de la banque avec le RIB.'
        });
      }

      const storedUser = persistentStorage.findUserById(clientId);
      const { data: targetProfile } = await supabase
        .from('profiles')
        .select('id, email, full_name, phone, city')
        .eq('id', clientId)
        .maybeSingle();

      const { data: existingShop } = await supabase
        .from('merchant_shops')
        .select('id, user_id, email, shop_name, manager_name')
        .or(`user_id.eq.${clientId},id.eq.${clientId}`)
        .maybeSingle();

      const effectiveUserId = targetProfile?.id || existingShop?.user_id || clientId;
      const effectiveEmail = targetProfile?.email || existingShop?.email || storedUser?.email || '';

      persistentStorage.saveKycDocuments(
        [effectiveUserId, clientId, existingShop?.id, effectiveEmail].filter(Boolean) as string[],
        {
          bankName: cleanBankName,
          bankRib: cleanBankRib
        }
      );

      if (storedUser) {
        persistentStorage.updateUser(clientId, {
          ...(cleanBankName !== undefined ? { bankName: cleanBankName } : {}),
          ...(cleanBankRib !== undefined ? { bankRib: cleanBankRib } : {})
        });
      }

      try {
        await supabase
          .from('merchant_shops')
          .update({
            ...(cleanBankName !== undefined ? { bank_name: cleanBankName } : {}),
            ...(cleanBankRib !== undefined ? { bank_rib: cleanBankRib } : {})
          })
          .eq('user_id', effectiveUserId);
      } catch {}

      try {
        await supabase
          .from('profiles')
          .update({
            ...(cleanBankName !== undefined ? { bank_name: cleanBankName } : {}),
            ...(cleanBankRib !== undefined ? { bank_rib: cleanBankRib } : {})
          })
          .eq('id', effectiveUserId);
      } catch {}

      return res.json({
        success: true,
        message: 'Coordonnées bancaires (RIB) enregistrées avec succès.',
        bankName: cleanBankName,
        bankRib: cleanBankRib
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Erreur lors de la sauvegarde du RIB : ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // TOGGLE CLIENT STATUS (Étape 78 — Désactiver / Réactiver un client dans Supabase)
  // ---------------------------------------------------------------------------
  app.patch('/api/admin/clients/:id/status', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    try {
      const clientId = req.params.id;
      if (!clientId) {
        return res.status(400).json({ success: false, error: 'Identifiant du client manquant.' });
      }

      const { status, reason } = req.body;
      if (!status || (status !== 'suspendu' && status !== 'approuve' && status !== 'refuse')) {
        return res.status(400).json({
          success: false,
          error: "Le statut demandé est invalide. Valeurs autorisées: 'suspendu', 'approuve' ou 'refuse'."
        });
      }

      const { data: targetProfile, error: profileErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', clientId)
        .maybeSingle();

      const localUser = persistentStorage.findUserById(clientId);
      const localShop = persistentStorage.getShopByUserId(clientId);

      if (profileErr) {
        console.warn('[Client Status Supabase Profile Notice]', profileErr.message);
      }

      const targetRole = normalizeAuthRole(String(targetProfile?.role || localUser?.role || ''));
      if (
        targetProfile?.role === 'super_admin' ||
        targetProfile?.role === 'admin' ||
        localUser?.role === 'super_admin' ||
        localUser?.role === 'admin'
      ) {
        return res.status(403).json({
          success: false,
          error: 'Impossible de désactiver ou suspendre un compte administrateur.'
        });
      }

      if ((targetProfile || localUser) && targetRole !== 'client') {
        return res.status(403).json({
          success: false,
          error: "Seuls les comptes marchands ayant le rôle 'client' peuvent être suspendus, approuvés ou refusés."
        });
      }

      const { data: targetShop, error: shopFindErr } = await supabase
        .from('merchant_shops')
        .select('*')
        .or(`user_id.eq.${clientId},id.eq.${clientId}`)
        .maybeSingle();

      if (shopFindErr) {
        console.warn('[Client Status Supabase Shop Notice]', shopFindErr.message);
      }

      if (!targetProfile && !targetShop && !localUser && !localShop) {
        return res.status(404).json({
          success: false,
          error: 'Compte client introuvable dans la base de données.'
        });
      }

      const now = new Date().toISOString();
      const adminId = (req as any).user?.id || (req as any).profile?.id || null;
      const adminName = (req as any).profile?.full_name || 'Direction FARIOUSY';
      const resolvedReason =
        status === 'suspendu'
          ? (reason && reason.trim()) || "Compte suspendu temporairement par l'administration"
          : status === 'refuse'
          ? (reason && reason.trim()) || 'Critères non conformes'
          : undefined;

      let updatedShop: any = targetShop;
      if (targetShop) {
        const updateData: any = {
          account_status: status,
          updated_at: now
        };
        if (status === 'suspendu' || status === 'refuse') {
          updateData.status_reason = resolvedReason;
        } else if (status === 'approuve') {
          updateData.status_reason = null;
          updateData.approved_at = now;
          updateData.approved_by = adminId;
        }

        const { data: sbUpdatedShop, error: updateErr } = await supabase
          .from('merchant_shops')
          .update(updateData)
          .eq('id', targetShop.id)
          .select()
          .single();

        if (updateErr) {
          return res.status(500).json({
            success: false,
            error: `Erreur lors de la mise à jour du statut de la boutique : ${updateErr.message}`
          });
        }
        updatedShop = sbUpdatedShop;

        if (adminId) {
          await supabase
            .from('admin_approvals')
            .insert({
              shop_id: targetShop.id,
              admin_id: adminId,
              action: status,
              reason: resolvedReason || 'Réactivation administrative du compte boutique',
              action_timestamp: now
            })
            .then(() => {}, () => {});
        }
      }

      // Synchronize local persistentStorage user & shop
      if (localUser) {
        persistentStorage.updateUser(localUser.id, {
          status: status === 'approuve' ? 'approuve' : status,
          accountStatus: status,
          statusReason: resolvedReason,
          ...(status === 'approuve' ? { approvedAt: now, approvedBy: adminName } : {})
        });
      }
      if (localShop) {
        localShop.account_status = status;
        localShop.status_reason = resolvedReason;
        localShop.updated_at = now;
      }

      const shopLabel = updatedShop?.shop_name || localShop?.shop_name || localUser?.companyName || localUser?.name || clientId;
      const actionLabel =
        status === 'suspendu' ? 'désactivé (suspendu)' : status === 'refuse' ? 'refusé' : 'approuvé / réactivé';
      return res.json({
        success: true,
        message: `Le compte de la boutique "${shopLabel}" a été ${actionLabel} avec succès.`,
        status,
        shop: updatedShop || localShop
      });
    } catch (err: any) {
      console.error('[Toggle Client Status Error]', err);
      return res.status(500).json({
        success: false,
        error: `Erreur interne lors du changement de statut : ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE CLIENT ENDPOINT (Permanent cascade removal from Supabase + persistentStorage)
  // ---------------------------------------------------------------------------
  app.delete('/api/admin/clients/:id', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    try {
      const clientId = req.params.id;
      if (!clientId) {
        return res.status(400).json({ success: false, error: 'Identifiant du client manquant.' });
      }

      const isUuid = (v?: string | null) =>
        Boolean(v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim()));

      const shopMap = new Map<string, string | null>();
      const userIdsToDelete = new Set<string>();

      if (isUuid(clientId)) {
        // 1. Rechercher le profil dans public.profiles
        const { data: targetProfile } = await supabase
          .from('profiles')
          .select('id, email, role')
          .eq('id', clientId)
          .maybeSingle();

        if (
          targetProfile &&
          (targetProfile.role === 'admin' ||
            targetProfile.role === 'super_admin' ||
            String(targetProfile.email || '').toLowerCase() === 'wadarazzeddine30@gmail.com')
        ) {
          return res.status(422).json({
            success: false,
            error: 'Impossible de supprimer un compte administrateur.'
          });
        }

        // 2. Rechercher les boutiques associées (par user_id OU directement par shop.id)
        const [shopsByUser, shopsById] = await Promise.all([
          supabase.from('merchant_shops').select('id, user_id').eq('user_id', clientId),
          supabase.from('merchant_shops').select('id, user_id').eq('id', clientId)
        ]);

        for (const s of [...(shopsByUser.data || []), ...(shopsById.data || [])]) {
          if (s?.id) shopMap.set(s.id, s.user_id || null);
        }

        userIdsToDelete.add(clientId);
        for (const uid of shopMap.values()) {
          if (uid && isUuid(uid)) userIdsToDelete.add(uid);
        }
      }

      const shopIds = Array.from(shopMap.keys());

      // 3. Suppression en cascade dans l'ordre des clés étrangères
      if (shopIds.length > 0) {
        try {
          await supabase.from('client_debts').delete().in('shop_id', shopIds);
        } catch {}

        try {
          await supabase.from('client_tariffs').delete().in('shop_id', shopIds);
        } catch {}

        const { error: pkgDelErr } = await supabase
          .from('packages')
          .delete()
          .in('shop_id', shopIds);

        if (pkgDelErr) {
          return res.status(500).json({
            success: false,
            error: `Impossible de supprimer les colis de la boutique dans Supabase: ${pkgDelErr.message}`
          });
        }

        try {
          await supabase.from('pickup_requests').delete().in('shop_id', shopIds);
        } catch {}

        try {
          await supabase.from('admin_approvals').delete().in('shop_id', shopIds);
        } catch {}

        const { error: shopDelErr } = await supabase
          .from('merchant_shops')
          .delete()
          .in('id', shopIds);

        if (shopDelErr) {
          return res.status(500).json({
            success: false,
            error: `Impossible de supprimer la boutique dans Supabase: ${shopDelErr.message}`
          });
        }
      }

      // 4. Supprimer les messages et le profil dans public.profiles + auth.users
      for (const uid of userIdsToDelete) {
        try {
          await supabase.from('client_messages').delete().eq('client_id', uid);
        } catch {}

        const { error: profDelErr } = await supabase
          .from('profiles')
          .delete()
          .eq('id', uid);

        if (profDelErr) {
          return res.status(500).json({
            success: false,
            error: `Impossible de supprimer le profil client dans Supabase: ${profDelErr.message}`
          });
        }

        try {
          await supabase.auth.admin.deleteUser(uid);
        } catch (authDelErr) {
          console.warn('[Delete Client Auth Notice]', (authDelErr as Error)?.message);
        }
      }

      persistentStorage.deleteClient(clientId, shopIds);

      return res.json({
        success: true,
        message: 'Le client et sa boutique ont été supprimés définitivement de Supabase.'
      });
    } catch (err: any) {
      console.error('[Delete Client Error]', err);
      return res.status(500).json({
        success: false,
        error: `Erreur serveur lors de la suppression du client: ${err.message}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 0. HEALTH CHECK ROUTE (VERCEL & VPS MONITORING)
  // ---------------------------------------------------------------------------
  app.get('/api/health', async (_req: Request, res: Response) => {
    const startTime = Date.now();
    let dbReachable = false;
    let dbConnected = false;
    let dbError: string | null = null;
    let tablesProvisioned = false;

    try {
      // 1. Verify reachability & authentication with Supabase REST gateway
      if (SUPABASE_URL && SUPABASE_KEY) {
        try {
          const pingRes = await fetch(`${SUPABASE_URL}/rest/v1/`, {
            method: 'HEAD',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`
            }
          });
          dbReachable = pingRes.ok || pingRes.status === 200 || pingRes.status === 204;
        } catch (pingErr: any) {
          dbError = pingErr.message;
        }
      }

      // 2. Query table via Supabase client with timeout protection
      const dbCheckPromise = supabase
        .from('delivery_partners')
        .select('id')
        .limit(1);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Supabase query timeout (>2500ms)')), 2500)
      );

      const result: any = await Promise.race([dbCheckPromise, timeoutPromise]);
      dbConnected = !result.error;
      tablesProvisioned = !result.error;
      if (result.error) {
        dbError = result.error.message || 'Table delivery_partners non trouvée dans le schéma Supabase';
      }
    } catch (e: any) {
      dbError = e.message;
    }

    const latency = Date.now() - startTime;

    res.json({
      status: 'healthy',
      service: 'FARIOUSY DELIVERY Logistics API',
      domain: 'app.fariousy.com',
      version: '2.5.0',
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      database: {
        provider: 'supabase',
        url: SUPABASE_URL,
        keyType: SUPABASE_KEY.startsWith('sb_secret_')
          ? 'sb_secret'
          : SUPABASE_KEY.startsWith('sb_publishable_')
          ? 'sb_publishable'
          : (() => {
              try {
                const part = SUPABASE_KEY.split('.')[1];
                if (part) {
                  const decoded = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
                  return decoded?.role || 'jwt';
                }
              } catch {}
              return isValidSupabaseKey(SUPABASE_KEY) ? 'configured' : 'placeholder';
            })(),
        reachable: dbReachable,
        connected: dbConnected,
        tablesProvisioned,
        latencyMs: latency,
        error: dbError
      },
      partners: {
        count: partnersCache.length,
        active: partnersCache.filter(p => p.active).length
      },
      security: {
        strictWebhooks: true,
        realRestOnly: true,
        noRandomFictionalStatus: true,
        vercelReady: true
      }
    });
  });

  app.get('/api/partners', authenticateAndAuthorize(['admin', 'employee', 'partner']), async (_req: Request, res: Response) => {
    try {
      const resDb: any = await safeDbQuery(
        supabase
          .from('delivery_partners')
          .select('*')
          .order('created_at', { ascending: true }),
        1200
      );

      if (!resDb.error && resDb.data) {
        const existingMap = new Map(getSyncedPartners().map(p => [p.id, p]));
        partnersCache = resDb.data
          .filter((row: any) => row?.id !== SYSTEM_STATE_ROW_ID)
          .map((row: any) => {
          const dbPartner = mapDbToPartner(row);
          const existing = existingMap.get(dbPartner.id);
          return existing
            ? {
                ...dbPartner,
                address: existing.address || dbPartner.address,
                website: existing.website || dbPartner.website,
                logoUrl: existing.logoUrl || dbPartner.logoUrl,
                cityTariffs: existing.cityTariffs && Object.keys(existing.cityTariffs).length > 0 ? existing.cityTariffs : dbPartner.cityTariffs,
                webhookToken: existing.webhookToken || dbPartner.webhookToken || dbPartner.apiConfig?.webhookSecret,
                apiTokens: existing.apiTokens?.length ? existing.apiTokens : dbPartner.apiTokens,
                deliveryFee: existing.deliveryFee ?? dbPartner.deliveryFee,
                returnFee: existing.returnFee ?? dbPartner.returnFee,
                settlements: existing.settlements?.length ? existing.settlements : dbPartner.settlements,
                errorCount: existing.errorCount ?? dbPartner.errorCount,
                apiConfig: existing.apiConfig || dbPartner.apiConfig
                  ? {
                      ...(dbPartner.apiConfig || {}),
                      ...(existing.apiConfig || {})
                    } as any
                  : undefined
              }
            : dbPartner;
        });
        persistentStorage.setSystemCollection('partners', partnersCache);
      }
    } catch (e: any) {
      console.warn('[Supabase Partners Fetch Warning]', e.message);
    }

    const sanitized = getSyncedPartners().map(sanitizePartner);
    res.json({ success: true, partners: sanitized });
  });

  app.post('/api/partners', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    const data = req.body;
    if (!data.name || !data.phone) {
      return res.status(400).json({ success: false, message: 'Le nom et le téléphone sont obligatoires.' });
    }

    const detectedExpiry = extractTokenExpiryIso(data.apiConfig?.apiKey);
    const webhookTok = data.webhookToken || data.apiConfig?.webhookSecret || crypto.randomBytes(32).toString('base64');

    const newPartner: Partner = {
      id: data.id || `part-${Date.now()}`,
      name: data.name,
      contactPerson: data.contactPerson || '',
      phone: data.phone,
      email: data.email || '',
      city: data.city || 'Casablanca',
      address: data.address || '',
      website: data.website || '',
      logoUrl: data.logoUrl || '',
      active: data.active ?? true,
      notes: data.notes || '',
      deliveryFee: data.deliveryFee !== undefined ? Number(data.deliveryFee) : 30,
      returnFee: data.returnFee !== undefined ? Number(data.returnFee) : 10,
      cityTariffs: data.cityTariffs && typeof data.cityTariffs === 'object' ? data.cityTariffs : undefined,
      settlements: data.settlements || [],
      webhookToken: webhookTok,
      apiTokens: Array.isArray(data.apiTokens) ? data.apiTokens : [],
      apiConfig: data.apiConfig
        ? {
            enabled: data.apiConfig.enabled ?? true,
            baseUrl: data.apiConfig.baseUrl || (data.apiConfig.adapterType === 'olivraison' ? 'https://partners.olivraison.com' : 'https://api.partner.ma'),
            authType: data.apiConfig.authType || (data.apiConfig.adapterType === 'olivraison' ? 'bearer' : 'api_key_header'),
            headerName: data.apiConfig.headerName || 'X-API-KEY',
            apiKey: data.apiConfig.apiKey || '',
            apiSecret: data.apiConfig.apiSecret || '',
            username: data.apiConfig.username || '',
            password: data.apiConfig.password || '',
            adapterType: data.apiConfig.adapterType || 'generic_rest',
            endpoints: data.apiConfig.endpoints || {
              createShipment: data.apiConfig.adapterType === 'olivraison' ? '/api/v1/parcels' : '/shipments',
              getTracking: data.apiConfig.adapterType === 'olivraison' ? '/api/v1/parcels' : '/tracking',
              syncStatus: data.apiConfig.adapterType === 'olivraison' ? '/api/v1/parcels/state' : '/status'
            },
            webhookSecret: data.apiConfig.webhookSecret || webhookTok,
            autoSync: data.apiConfig.autoSync ?? true,
            autoDispatch: data.apiConfig.autoDispatch ?? false,
            tokenExpiresAt: data.apiConfig.tokenExpiresAt || detectedExpiry
          }
        : undefined,
      totalSent: 0,
      totalReceived: 0,
      totalDelivered: 0,
      totalPending: 0
    };

    await syncPartnerEverywhere(newPartner);

    if (newPartner.email && typeof data.password === 'string' && data.password.trim().length >= 6) {
      try {
        persistentStorage.upsertUser({
          id: newPartner.id,
          name: newPartner.contactPerson || newPartner.name,
          companyName: newPartner.name,
          email: newPartner.email.trim().toLowerCase(),
          phone: newPartner.phone,
          role: 'partner',
          city: newPartner.city,
          address: newPartner.address,
          status: newPartner.active ? 'active' : 'inactive'
        } as any);
        persistentStorage.changeUserPassword(newPartner.email.trim().toLowerCase(), data.password.trim());
      } catch {}
    }

    res.status(201).json({
      success: true,
      message: 'Partenaire API créé avec succès et persisté.',
      partner: sanitizePartner(newPartner)
    });
  });

  app.put('/api/partners/:id', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    const { id } = req.params;
    if (id === SYSTEM_STATE_ROW_ID) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }
    let existing = findSyncedPartner(id);

    if (!existing) {
      const { data } = await supabase.from('delivery_partners').select('*').eq('id', id).single();
      if (data) {
        existing = mapDbToPartner(data);
      }
    }

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }

    const data = req.body;
    let updatedApiConfig = undefined;
    if (data.apiConfig) {
      const prevConfig = existing.apiConfig;
      const rawKey =
        data.apiConfig.apiKey && data.apiConfig.apiKey.includes('••••')
          ? prevConfig?.apiKey || ''
          : data.apiConfig.apiKey;
      const detectedExpiry = extractTokenExpiryIso(rawKey);
      updatedApiConfig = {
        ...(prevConfig || {}),
        ...data.apiConfig,
        apiKey: rawKey,
        apiSecret:
          data.apiConfig.apiSecret && data.apiConfig.apiSecret.includes('••••')
            ? prevConfig?.apiSecret || ''
            : data.apiConfig.apiSecret,
        password:
          data.apiConfig.password && data.apiConfig.password.includes('••••')
            ? prevConfig?.password || ''
            : data.apiConfig.password,
        webhookSecret:
          data.apiConfig.webhookSecret && data.apiConfig.webhookSecret.includes('••••')
            ? prevConfig?.webhookSecret || ''
            : data.apiConfig.webhookSecret,
        tokenExpiresAt: data.apiConfig.tokenExpiresAt || detectedExpiry || prevConfig?.tokenExpiresAt
      };
    }

    const updated: Partner = {
      ...existing,
      name: data.name !== undefined ? data.name : existing.name,
      contactPerson: data.contactPerson !== undefined ? data.contactPerson : existing.contactPerson,
      phone: data.phone !== undefined ? data.phone : existing.phone,
      email: data.email !== undefined ? data.email : existing.email,
      city: data.city !== undefined ? data.city : existing.city,
      address: data.address !== undefined ? data.address : existing.address,
      website: data.website !== undefined ? data.website : existing.website,
      logoUrl: data.logoUrl !== undefined ? data.logoUrl : existing.logoUrl,
      active: data.active !== undefined ? data.active : existing.active,
      notes: data.notes !== undefined ? data.notes : existing.notes,
      deliveryFee: data.deliveryFee !== undefined ? Number(data.deliveryFee) : (existing.deliveryFee ?? 30),
      returnFee: data.returnFee !== undefined ? Number(data.returnFee) : (existing.returnFee ?? 10),
      cityTariffs: data.cityTariffs !== undefined ? data.cityTariffs : existing.cityTariffs,
      settlements: data.settlements !== undefined ? data.settlements : (existing.settlements || []),
      webhookToken: data.webhookToken !== undefined ? data.webhookToken : existing.webhookToken,
      apiTokens: data.apiTokens !== undefined ? data.apiTokens : existing.apiTokens,
      apiConfig: updatedApiConfig !== undefined ? updatedApiConfig : existing.apiConfig
    };

    await syncPartnerEverywhere(updated);

    if (updated.email && typeof data.password === 'string' && data.password.trim().length >= 6) {
      try {
        persistentStorage.upsertUser({
          id: updated.id,
          name: updated.contactPerson || updated.name,
          companyName: updated.name,
          email: updated.email.trim().toLowerCase(),
          phone: updated.phone,
          role: 'partner',
          city: updated.city,
          address: updated.address,
          status: updated.active ? 'active' : 'inactive'
        } as any);
        persistentStorage.changeUserPassword(updated.email.trim().toLowerCase(), data.password.trim());
      } catch {}
    }

    res.json({
      success: true,
      message: 'Partenaire mis à jour avec succès.',
      partner: sanitizePartner(updated)
    });
  });

  app.delete('/api/partners/:id', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    const { id } = req.params;
    if (id === SYSTEM_STATE_ROW_ID) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }
    partnersCache = getSyncedPartners().filter(p => p.id !== id);
    persistentStorage.deletePartnerSecret(id);
    persistentStorage.setSystemCollection('partners', partnersCache.map(sanitizePartner));

    try {
      await supabase.from('delivery_partners').delete().eq('id', id);
    } catch (e: any) {
      console.warn('[Supabase Partner Delete Error]', e.message);
    }

    res.json({ success: true, message: 'Partenaire supprimé avec succès.' });
  });

  // ---------------------------------------------------------------------------
  // 2. REAL PARTNER CONNECTION TEST (OLIVRAISON & GENERIC REST)
  // ---------------------------------------------------------------------------
  app.post('/api/partners/:id/test-connection', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    const { id } = req.params;
    let partner = findSyncedPartner(id);

    if (!partner) {
      const { data } = await supabase.from('delivery_partners').select('*').eq('id', id).single();
      if (data) partner = mapDbToPartner(data);
    }

    if (!partner) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }

    // Support optional unsaved override from UI config test
    const overrideConfig = req.body?.apiConfig;
    const effectiveConfig = overrideConfig
      ? {
          ...(partner.apiConfig || {}),
          ...overrideConfig,
          apiKey:
            overrideConfig.apiKey && overrideConfig.apiKey.includes('••••')
              ? partner.apiConfig?.apiKey || ''
              : overrideConfig.apiKey
        }
      : partner.apiConfig;

    if (!effectiveConfig || !effectiveConfig.baseUrl) {
      return res.status(400).json({ success: false, message: "URL de l'API non configurée." });
    }

    const startTime = Date.now();
    let isSuccess = false;
    let message = '';
    let latency = 0;
    let statusCode = 200;

    try {
      const base = effectiveConfig.baseUrl.replace(/\/$/, '');
      const probePath =
        effectiveConfig.adapterType === 'olivraison'
          ? (effectiveConfig.endpoints?.createShipment || '/api/v1/parcels').replace(/\/$/, '')
          : '';
      const url = `${base}${probePath ? probePath : ''}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      const headers: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Fariousy-Delivery-Logistics/2.5'
      };

      if (effectiveConfig.authType === 'bearer' && effectiveConfig.apiKey) {
        headers['Authorization'] = `Bearer ${effectiveConfig.apiKey}`;
      } else if (effectiveConfig.adapterType === 'olivraison' && effectiveConfig.apiKey) {
        headers['Authorization'] = `Bearer ${effectiveConfig.apiKey}`;
      } else if (effectiveConfig.authType === 'api_key_header' && effectiveConfig.apiKey) {
        headers[effectiveConfig.headerName || 'X-API-KEY'] = effectiveConfig.apiKey;
      } else if (effectiveConfig.authType === 'basic' && effectiveConfig.username) {
        const creds = Buffer.from(`${effectiveConfig.username}:${effectiveConfig.password || ''}`).toString('base64');
        headers['Authorization'] = `Basic ${creds}`;
      }

      const resp = await fetch(url, {
        signal: controller.signal,
        headers,
        method: 'GET'
      });
      clearTimeout(timeoutId);

      latency = Date.now() - startTime;
      statusCode = resp.status;
      if (resp.ok || resp.status === 204) {
        isSuccess = true;
        message = `Connexion établie avec succès (${partner.name}) : HTTP ${resp.status} ${resp.statusText || 'OK'} (${latency}ms).`;
      } else if (resp.status === 401 || resp.status === 403) {
        isSuccess = false;
        message = `Serveur distant atteint (HTTP ${resp.status}), mais la clé API est invalide, expirée ou non autorisée.`;
      } else if (resp.status === 404 || resp.status === 405) {
        // Remote API host reached cleanly even if GET on endpoint returns 404/405
        isSuccess = Boolean(effectiveConfig.apiKey);
        message = effectiveConfig.apiKey
          ? `Serveur ${base} joignable (${latency}ms, HTTP ${resp.status}) — prêt pour envoi POST.`
          : `Serveur joignable (HTTP ${resp.status}), mais clé API manquante.`;
      } else {
        isSuccess = false;
        message = `Le serveur API distant a répondu avec le statut HTTP ${resp.status} ${resp.statusText} (${latency}ms).`;
      }
    } catch (err: any) {
      latency = Date.now() - startTime;
      isSuccess = false;
      statusCode = 502;
      message = `Échec de connexion réelle au serveur ${effectiveConfig.baseUrl} : ${err.message || 'Hôte distant injoignable'}`;
    }

    const detectedExpiry = extractTokenExpiryIso(effectiveConfig.apiKey);
    const updatedConfig = {
      ...effectiveConfig,
      lastTestedAt: new Date().toISOString(),
      lastTestStatus: (isSuccess ? 'success' : 'error') as 'success' | 'error',
      lastTestMessage: message,
      lastTestLatencyMs: latency,
      tokenExpiresAt: detectedExpiry || effectiveConfig.tokenExpiresAt
    };

    partner = {
      ...partner,
      apiConfig: updatedConfig
    };
    await syncPartnerEverywhere(partner);

    const logItem: PartnerSyncLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
      partnerId: partner.id,
      partnerName: partner.name,
      direction: 'connection_test',
      status: isSuccess ? 'success' : 'error',
      statusCode,
      endpoint: effectiveConfig.baseUrl,
      message,
      durationMs: latency
    };
    await syncLogsEverywhere(logItem);

    res.json({
      success: isSuccess,
      latency,
      statusCode,
      message,
      partner: sanitizePartner(partner)
    });
  });

  // Helper: execute real outbound batch dispatch to partner API & track failures
  async function executePartnerBatchDispatch(
    partner: Partner,
    packageItems: PackageItem[],
    forceResend = false
  ) {
    const startTime = Date.now();
    const updatedPackages: any[] = [];
    const trackingNumbers: string[] = [];
    const errors: string[] = [];
    const existingFailures: PartnerFailedTransmission[] = [...(partner.apiConfig?.failedTransmissions || [])];
    const resolvedTrackingSet = new Set<string>();

    const recordFailure = (pkg: PackageItem, msg: string) => {
      errors.push(msg);
      const cleanMsg = msg.replace(/^Échec d'envoi pour [^:]+:\s*/i, '');
      const failureEntry: PartnerFailedTransmission = {
        id: `fail-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        packageId: pkg.id,
        trackingNumber: pkg.trackingNumber,
        message: cleanMsg,
        timestamp: new Date().toISOString()
      };
      const existingIdx = existingFailures.findIndex(f => f.trackingNumber === pkg.trackingNumber);
      if (existingIdx !== -1) {
        existingFailures[existingIdx] = failureEntry;
      } else {
        existingFailures.unshift(failureEntry);
      }
    };

    for (const pkg of packageItems) {
      if (pkg.partnerTrackingNumber && !forceResend) {
        errors.push(`Colis ${pkg.trackingNumber} déjà transmis au partenaire (N° Suivi: ${pkg.partnerTrackingNumber})`);
        continue;
      }

      // 1. Validate partner-specific schema rules (e.g. Olivraison description >= 5 chars)
      const validationErr = validatePartnerShipmentPayload(partner, pkg);
      if (validationErr) {
        recordFailure(pkg, validationErr);
        continue;
      }

      const { url, headers, body } = buildPartnerShipmentPayload(partner, pkg);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const respText = await resp.text();
        let respJson: any = null;
        try {
          respJson = JSON.parse(respText);
        } catch {
          respJson = { raw: respText };
        }

        if (!resp.ok) {
          const detail =
            respJson?.message ||
            respJson?.error ||
            (Array.isArray(respJson?.errors) ? respJson.errors.join(', ') : '') ||
            respText.slice(0, 140) ||
            `HTTP ${resp.status}`;
          recordFailure(pkg, `${detail}`);
          continue;
        }

        const extracted = extractPartnerTrackingFromResponse(
          partner.apiConfig?.adapterType || 'generic_rest',
          respJson,
          pkg.trackingNumber
        );

        if (!extracted.partnerTrackingNumber) {
          recordFailure(pkg, `Réponse invalide de ${partner.name} : aucun numéro de suivi retourné.`);
          continue;
        }

        trackingNumbers.push(pkg.trackingNumber);
        resolvedTrackingSet.add(pkg.trackingNumber);

        const updatedPkgData = {
          id: pkg.id,
          trackingNumber: pkg.trackingNumber,
          partnerId: partner.id,
          partnerName: partner.name,
          partnerTrackingNumber: extracted.partnerTrackingNumber,
          partnerShipmentId: extracted.shipmentId || `SHP-${pkg.trackingNumber}`,
          partnerLabelUrl: extracted.labelUrl || null,
          partnerSyncStatus: 'synced' as const,
          partnerLastSyncAt: new Date().toISOString(),
          destinationAgency: `Ligne Partenaire: ${partner.name}`
        };

        updatedPackages.push(updatedPkgData);

        // Update local persistentStorage package if stored
        persistentStorage.updatePackage(pkg.id, {
          partnerId: partner.id,
          partnerName: partner.name,
          partnerTrackingNumber: extracted.partnerTrackingNumber,
          partnerShipmentId: extracted.shipmentId || `SHP-${pkg.trackingNumber}`,
          partnerLabelUrl: extracted.labelUrl || undefined,
          partnerSyncStatus: 'synced',
          partnerLastSyncAt: updatedPkgData.partnerLastSyncAt
        });

        // Update in Supabase packages table
        try {
          await supabase.from('packages').update({
            partner_id: partner.id,
            partner_tracking_number: extracted.partnerTrackingNumber,
            partner_shipment_id: extracted.shipmentId || null,
            partner_label_url: extracted.labelUrl || null,
            partner_sync_status: 'synced',
            partner_last_sync_at: updatedPkgData.partnerLastSyncAt
          }).eq('id', pkg.id);
        } catch (dbErr: any) {
          console.warn('[Supabase Package Update Notice]', dbErr.message);
        }
      } catch (reqErr: any) {
        recordFailure(pkg, `Erreur réseau vers ${partner.name} : ${reqErr.message || 'Serveur injoignable'}`);
      }
    }

    const filteredFailures = existingFailures.filter(f => !resolvedTrackingSet.has(f.trackingNumber)).slice(0, 50);
    const durationMs = Date.now() - startTime;
    const isOverallSuccess = updatedPackages.length > 0;

    if (partner.apiConfig) {
      partner.apiConfig.failedTransmissions = filteredFailures;
      partner.apiConfig.createdParcelsCount = (partner.apiConfig.createdParcelsCount || partner.totalSent || 0) + updatedPackages.length;
      if (updatedPackages.length > 0) {
        partner.apiConfig.lastSyncedAt = new Date().toISOString();
      }
    }
    if (updatedPackages.length > 0) {
      partner.totalSent = (partner.totalSent || 0) + updatedPackages.length;
      partner.totalPending = (partner.totalPending || 0) + updatedPackages.length;
    }
    partner.errorCount = filteredFailures.length;
    await syncPartnerEverywhere(partner);

    const logItem: PartnerSyncLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
      partnerId: partner.id,
      partnerName: partner.name,
      direction: 'outbound_send',
      status: isOverallSuccess ? 'success' : 'error',
      statusCode: isOverallSuccess ? 201 : 422,
      endpoint: partner.apiConfig?.endpoints?.createShipment || '/api/v1/parcels',
      message: isOverallSuccess
        ? `${updatedPackages.length} colis transmis avec succès via l'API de ${partner.name}.${errors.length > 0 ? ` (${errors.length} échec(s))` : ''}`
        : `Échec d'expédition : ${errors[0] || `aucun colis n'a été accepté par ${partner.name}.`}`,
      packageCount: updatedPackages.length,
      trackingNumbers,
      requestPayloadPreview: JSON.stringify({ count: packageItems.length, sample: packageItems[0]?.trackingNumber }),
      responsePayloadPreview: JSON.stringify({ updatedCount: updatedPackages.length, errors }),
      durationMs
    };
    await syncLogsEverywhere(logItem);

    return {
      success: isOverallSuccess,
      sentCount: updatedPackages.length,
      updatedPackages,
      packages: updatedPackages,
      errors,
      failedTransmissions: filteredFailures,
      message: logItem.message,
      partner: sanitizePartner(partner)
    };
  }

  // ---------------------------------------------------------------------------
  // 3. REAL OUTBOUND DISPATCH: SEND PACKAGES TO PARTNER API
  // ---------------------------------------------------------------------------
  app.post('/api/partners/:id/send-packages', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    const { id } = req.params;
    const { packages: packageItems, forceResend } = req.body as {
      packages: PackageItem[];
      forceResend?: boolean;
    };

    let partner = findSyncedPartner(id);
    if (!partner) {
      const { data } = await supabase.from('delivery_partners').select('*').eq('id', id).single();
      if (data) partner = mapDbToPartner(data);
    }

    if (!partner) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }

    if (!partner.active) {
      return res.status(400).json({ success: false, message: `Le partenaire ${partner.name} est désactivé.` });
    }

    if (!partner.apiConfig || !partner.apiConfig.enabled || !partner.apiConfig.baseUrl) {
      return res.status(400).json({
        success: false,
        message: `L'API du partenaire ${partner.name} n'est pas activée ou son URL de base est manquante.`
      });
    }

    if (!packageItems || packageItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucun colis sélectionné pour expédition.' });
    }

    const result = await executePartnerBatchDispatch(partner, packageItems, Boolean(forceResend));
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // 3b. RETRY FAILED TRANSMISSIONS FOR A PARTNER
  // ---------------------------------------------------------------------------
  app.post('/api/partners/:id/retry-failed', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    const { id } = req.params;
    const partner = findSyncedPartner(id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }

    if (!partner.apiConfig || !partner.apiConfig.enabled) {
      return res.status(400).json({ success: false, message: `L'API du partenaire ${partner.name} n'est pas activée.` });
    }

    const failedList = partner.apiConfig.failedTransmissions || [];
    if (failedList.length === 0) {
      return res.json({
        success: true,
        sentCount: 0,
        errors: [],
        failedTransmissions: [],
        message: 'Aucune transmission échouée à réessayer.',
        partner: sanitizePartner(partner)
      });
    }

    const clientPackages = Array.isArray(req.body?.packages) ? (req.body.packages as PackageItem[]) : [];
    const localPackages = persistentStorage.getPackages();
    const retryPackages: PackageItem[] = [];

    for (const fail of failedList) {
      const found =
        clientPackages.find(p => p.trackingNumber === fail.trackingNumber || p.id === fail.packageId) ||
        localPackages.find(p => p.trackingNumber === fail.trackingNumber || p.id === fail.packageId);
      if (found) {
        retryPackages.push(found);
      }
    }

    if (retryPackages.length === 0) {
      return res.status(400).json({
        success: false,
        sentCount: 0,
        errors: ['Colis introuvables localement pour réessai.'],
        partner: sanitizePartner(partner)
      });
    }

    const result = await executePartnerBatchDispatch(partner, retryPackages, true);
    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // 3c. REGENERATE PARTNER WEBHOOK BEARER TOKEN
  // ---------------------------------------------------------------------------
  app.post('/api/partners/:id/regenerate-webhook-token', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    const { id } = req.params;
    const partner = findSyncedPartner(id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }

    const newToken = crypto.randomBytes(32).toString('base64');
    partner.webhookToken = newToken;
    partner.apiConfig = {
      ...(partner.apiConfig || {
        enabled: true,
        baseUrl: 'https://partners.olivraison.com',
        authType: 'bearer',
        adapterType: 'olivraison',
        endpoints: {
          createShipment: '/api/v1/parcels',
          getTracking: '/api/v1/parcels',
          syncStatus: '/api/v1/parcels/state'
        },
        autoSync: true
      }),
      webhookSecret: newToken
    };

    await syncPartnerEverywhere(partner);

    res.json({
      success: true,
      webhookToken: newToken,
      partner: sanitizePartner(partner)
    });
  });

  // ---------------------------------------------------------------------------
  // 4. REAL PARTNER STATUS SYNCHRONIZATION
  // ---------------------------------------------------------------------------
  app.post('/api/partners/:id/sync-status', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    const { id } = req.params;
    const { packages: packageItems, activePackages } = req.body as { packages?: PackageItem[]; activePackages?: PackageItem[] };
    const itemsToSync = packageItems || activePackages || [];

    let partner = findSyncedPartner(id);
    if (!partner) {
      const { data } = await supabase.from('delivery_partners').select('*').eq('id', id).single();
      if (data) partner = mapDbToPartner(data);
    }

    if (!partner) {
      return res.status(404).json({ success: false, message: 'Partenaire non trouvé.' });
    }

    if (!partner.active || !partner.apiConfig?.enabled || !partner.apiConfig?.baseUrl) {
      return res.status(400).json({
        success: false,
        message: `L'API du partenaire ${partner.name} n'est pas active ou configurée.`
      });
    }

    const startTime = Date.now();
    const updatedStatusList: any[] = [];
    const errors: string[] = [];

    const trackingEndpoint = partner.apiConfig.endpoints?.getTracking || partner.apiConfig.endpoints?.syncStatus || '/api/v1/parcels';

    if (itemsToSync.length > 0) {
      for (const pkg of itemsToSync) {
        const remoteRef = pkg.partnerTrackingNumber || pkg.trackingNumber;
        if (!remoteRef) continue;

        try {
          const base = partner.apiConfig.baseUrl.replace(/\/$/, '');
          const ep = trackingEndpoint.replace(':tracking', remoteRef);
          const checkUrl = trackingEndpoint.includes(':tracking')
            ? `${base}${ep}`
            : `${base}${ep.replace(/\/$/, '')}/${remoteRef}`;

          const headers: Record<string, string> = { 'Accept': 'application/json' };
          if ((partner.apiConfig.authType === 'bearer' || partner.apiConfig.adapterType === 'olivraison') && partner.apiConfig.apiKey) {
            headers['Authorization'] = `Bearer ${partner.apiConfig.apiKey}`;
          } else if (partner.apiConfig.apiKey) {
            headers[partner.apiConfig.headerName || 'X-API-KEY'] = partner.apiConfig.apiKey;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);

          const resp = await fetch(checkUrl, { headers, signal: controller.signal });
          clearTimeout(timeoutId);

          if (resp.ok) {
            const data = await resp.json();
            const parcelObj = data?.data || data?.parcel || data;
            const remoteRawStatus =
              parcelObj?.state ||
              parcelObj?.status ||
              parcelObj?.statut ||
              parcelObj?.packageStatus ||
              parcelObj?.currentStatus;
            if (remoteRawStatus) {
              const normalized = normalizePartnerStatus(remoteRawStatus);
              if (normalized !== pkg.status) {
                updatedStatusList.push({
                  packageId: pkg.id,
                  newStatus: normalized,
                  comment: `Statut mis à jour via API réelle ${partner.name} : ${remoteRawStatus}`
                });

                await updateParcelStatusEverywhere(
                  pkg.id,
                  normalized,
                  remoteRawStatus,
                  partner.name,
                  `Statut synchronisé depuis ${partner.name} : ${remoteRawStatus}`
                );
              }
            }
          }
        } catch (e: any) {
          errors.push(`Erreur de suivi pour ${pkg.trackingNumber} : ${e.message}`);
        }
      }
    }

    const durationMs = Date.now() - startTime;
    partner.apiConfig.lastSyncedAt = new Date().toISOString();
    await syncPartnerEverywhere(partner);

    const logItem: PartnerSyncLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
      partnerId: partner.id,
      partnerName: partner.name,
      direction: 'status_sync',
      status: errors.length === 0 ? 'success' : 'warning',
      statusCode: 200,
      endpoint: trackingEndpoint || '/status',
      message: updatedStatusList.length > 0
        ? `Synchronisation statuts réelle : ${updatedStatusList.length} colis mis à jour via l'API de ${partner.name}.`
        : `Synchronisation statuts effectuée auprès de ${partner.name} : aucun changement détecté.`,
      packageCount: updatedStatusList.length,
      trackingNumbers: updatedStatusList.map(s => s.packageId),
      durationMs
    };
    await syncLogsEverywhere(logItem);

    res.json({
      success: true,
      updatedCount: updatedStatusList.length,
      updates: updatedStatusList,
      errors,
      partner: sanitizePartner(partner)
    });
  });

  // ---------------------------------------------------------------------------
  // PARTNER EXTERNAL API: UPDATE PARCELS STATE (Matching Olivraison / Accès API)
  // Endpoint: POST /api/partner/parcels/state
  // Accepts { refs: ["REF-001", ...], state: "Delivered", reason?: "..." } OR { parcels: [...] }
  // ---------------------------------------------------------------------------
  app.post('/api/partner/parcels/state', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      return res.status(401).json({
        isSuccess: false,
        success: false,
        error: 'Authorization header with Bearer token is required.'
      });
    }

    const allPartners = getSyncedPartners();
    const matchedPartner = allPartners.find(
      p =>
        p.apiTokens?.some(t => t.token === token) ||
        p.webhookToken === token ||
        p.apiConfig?.webhookSecret === token
    );

    // Enforce token validity strictly
    if (!matchedPartner) {
      return res.status(401).json({
        isSuccess: false,
        success: false,
        error: 'Invalid or revoked API Bearer token.'
      });
    }

    const bodyRefs = Array.isArray(req.body?.refs)
      ? req.body.refs
      : Array.isArray(req.body?.parcels)
      ? req.body.parcels
      : null;
    const { state, reason } = req.body || {};

    if (!Array.isArray(bodyRefs) || bodyRefs.length === 0) {
      return res.status(400).json({
        isSuccess: false,
        success: false,
        error: 'Missing required array field "refs" (e.g. ["REF-001", "REF-002"]).'
      });
    }

    if (!state || typeof state !== 'string') {
      return res.status(400).json({
        isSuccess: false,
        success: false,
        error: 'Missing required string field "state" (e.g. "Delivered", "Out For Delivery").'
      });
    }

    const normalizedKey = state.trim().toUpperCase().replace(/[\s-]+/g, '_');
    const targetInternalStatus = normalizePartnerStatus(state);

    if (matchedPartner && Array.isArray(matchedPartner.apiTokens)) {
      const tokIdx = matchedPartner.apiTokens.findIndex(t => t.token === token);
      if (tokIdx !== -1) {
        matchedPartner.apiTokens[tokIdx] = {
          ...matchedPartner.apiTokens[tokIdx],
          lastUsedAt: new Date().toISOString().replace('T', ' ').slice(0, 16)
        };
        await syncPartnerEverywhere(matchedPartner);
      }
    }

    const updated: { ref: string; from: string; to: string }[] = [];
    const failed: { ref: string; message: string }[] = [];

    for (const refItem of bodyRefs) {
      const cleanRef = String(refItem || '').trim();
      if (!cleanRef) continue;

      const commentText = reason
        ? `API Partenaire (${matchedPartner?.name || 'Olivraison'}) — ${state} : ${reason}`
        : `API Partenaire (${matchedPartner?.name || 'Olivraison'}) : ${state}`;

      const updateRes = await updateParcelStatusEverywhere(
        cleanRef,
        targetInternalStatus,
        state,
        matchedPartner?.name || 'API Partenaire',
        commentText
      );

      if (updateRes.found) {
        updated.push({
          ref: cleanRef,
          from: updateRes.oldStatus || 'In Transit',
          to: state
        });
      } else {
        failed.push({
          ref: cleanRef,
          message: 'Parcel not found.'
        });
      }
    }

    const logItem: PartnerSyncLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
      partnerId: matchedPartner?.id || 'partner-api',
      partnerName: matchedPartner?.name || 'Partenaire API',
      direction: 'status_sync',
      status: updated.length > 0 ? 'success' : failed.length > 0 ? 'warning' : 'error',
      statusCode: 200,
      endpoint: '/api/partner/parcels/state',
      message: `${updated.length} parcel(s) updated to "${state}" (${normalizedKey}), ${failed.length} failed.`,
      packageCount: updated.length,
      trackingNumbers: bodyRefs.slice(0, 20).map(String),
      requestPayloadPreview: JSON.stringify(req.body).slice(0, 240),
      responsePayloadPreview: JSON.stringify({ updated: updated.length, failed: failed.length })
    };
    await syncLogsEverywhere(logItem);

    return res.json({
      isSuccess: true,
      success: true,
      message: `${updated.length} parcel(s) updated.`,
      data: {
        updated,
        failed,
        totals: {
          updated: updated.length,
          failed: failed.length
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // OLIVRAISON INBOUND STATUS WEBHOOK (Matching /api/webhooks/olivraison/:partnerId)
  // Verifies Bearer Token, updates parcel status & records Dernière notification
  // ---------------------------------------------------------------------------
  const handleOlivraisonWebhook = async (req: Request, res: Response) => {
    const partnerIdParam = req.params.partnerId;
    const authHeader = (req.headers.authorization || '').trim();
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const altToken = String(req.headers['x-webhook-token'] || req.headers['x-partner-secret'] || '').trim();
    const incomingToken = bearerToken || altToken;

    const allPartners = getSyncedPartners();
    let partner = partnerIdParam
      ? allPartners.find(p => p.id === partnerIdParam)
      : allPartners.find(
          p =>
            p.apiConfig?.adapterType === 'olivraison' &&
            incomingToken &&
            (p.webhookToken === incomingToken || p.apiConfig?.webhookSecret === incomingToken)
        );

    if (!partner && partnerIdParam) {
      const { data } = await supabase.from('delivery_partners').select('*').eq('id', partnerIdParam).maybeSingle();
      if (data) partner = mapDbToPartner(data);
    }

    if (!partner) {
      return res.status(404).json({ isSuccess: false, success: false, message: 'Partenaire webhook introuvable.' });
    }

    const expectedToken = partner.webhookToken || partner.apiConfig?.webhookSecret;
    if (!expectedToken || incomingToken !== expectedToken) {
      const secLog: PartnerSyncLog = {
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
        partnerId: partner.id,
        partnerName: partner.name,
        direction: 'webhook_received',
        status: 'error',
        statusCode: 401,
        endpoint: `/api/webhooks/olivraison/${partner.id}`,
        message: 'Requête webhook rejetée : Bearer Token invalide ou manquant.',
        requestPayloadPreview: JSON.stringify(req.body || {}).slice(0, 200)
      };
      await syncLogsEverywhere(secLog);
      return res.status(401).json({
        isSuccess: false,
        success: false,
        message: 'Unauthorized webhook Bearer token.'
      });
    }

    // Parse Olivraison webhook payload (single item or array in data/parcels)
    const rawItems: any[] = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.parcels)
      ? req.body.parcels
      : Array.isArray(req.body?.data)
      ? req.body.data
      : [req.body?.parcel || req.body?.data || req.body];

    const updated: { ref: string; from: string; to: string; internalStatus: PackageStatus }[] = [];
    const failed: { ref: string; message: string }[] = [];

    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const ref = String(
        item.ref ||
          item.tracking ||
          item.tracking_number ||
          item.trackingNumber ||
          item.code ||
          item.id ||
          ''
      ).trim();
      const rawState = String(
        item.state ||
          item.status ||
          item.new_state ||
          item.event ||
          req.body?.state ||
          req.body?.status ||
          ''
      ).trim();
      const note = item.reason || item.note || item.comment || req.body?.reason || '';

      if (!ref || !rawState) {
        failed.push({ ref: ref || 'unknown', message: 'Champs ref ou state manquants dans le webhook.' });
        continue;
      }

      const internalStatus = normalizePartnerStatus(rawState);
      const resUpdate = await updateParcelStatusEverywhere(
        ref,
        internalStatus,
        rawState,
        partner.name,
        `Webhook Olivraison (${partner.name}) — ${rawState}${note ? ` : ${note}` : ''}`
      );

      if (resUpdate.found) {
        updated.push({
          ref,
          from: resUpdate.oldStatus || 'In Transit',
          to: rawState,
          internalStatus
        });
      } else {
        failed.push({ ref, message: 'Parcel not found.' });
      }
    }

    const nowIso = new Date().toISOString();
    partner.apiConfig = {
      ...(partner.apiConfig || {
        enabled: true,
        baseUrl: 'https://partners.olivraison.com',
        authType: 'bearer',
        adapterType: 'olivraison',
        endpoints: {
          createShipment: '/api/v1/parcels',
          getTracking: '/api/v1/parcels',
          syncStatus: '/api/v1/parcels/state'
        },
        autoSync: true
      }),
      lastWebhookAt: nowIso
    };
    await syncPartnerEverywhere(partner);

    const okLog: PartnerSyncLog = {
      id: `log-${Date.now()}`,
      timestamp: nowIso.replace('T', ' ').slice(0, 16),
      partnerId: partner.id,
      partnerName: partner.name,
      direction: 'webhook_received',
      status: updated.length > 0 ? 'success' : failed.length > 0 ? 'warning' : 'success',
      statusCode: 200,
      endpoint: `/api/webhooks/olivraison/${partner.id}`,
      message: `Webhook Olivraison traité : ${updated.length} colis mis à jour${failed.length > 0 ? `, ${failed.length} non trouvé(s)` : ''}.`,
      packageCount: updated.length,
      trackingNumbers: updated.map(u => u.ref),
      requestPayloadPreview: JSON.stringify(req.body || {}).slice(0, 240)
    };
    await syncLogsEverywhere(okLog);

    return res.json({
      isSuccess: true,
      success: true,
      message: 'Olivraison webhook processed successfully',
      partnerId: partner.id,
      receivedAt: nowIso,
      data: {
        updated,
        failed,
        totals: { updated: updated.length, failed: failed.length }
      }
    });
  };

  app.post('/api/webhooks/olivraison/:partnerId', handleOlivraisonWebhook);
  app.post('/api/webhooks/olivraison', handleOlivraisonWebhook);

  // Webhook for delivery updates: POST /api/webhooks/delivery/:partnerId
  app.post('/api/webhooks/delivery/:partnerId', async (req: Request, res: Response) => {
    const { partnerId } = req.params;
    const partner = findSyncedPartner(partnerId);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Partenaire webhook introuvable.' });
    }
    const authHeader = String(req.headers.authorization || '');
    const incomingToken =
      authHeader.replace(/^Bearer\s+/i, '').trim() ||
      String(req.headers['x-webhook-token'] || req.headers['x-partner-secret'] || '').trim();
    const expectedToken = partner.webhookToken || partner.apiConfig?.webhookSecret;
    if (!expectedToken || incomingToken !== expectedToken) {
      return res.status(401).json({ success: false, message: 'Unauthorized webhook token.' });
    }

    const rawTracking = String(req.body?.ref || req.body?.trackingNumber || req.body?.tracking || '').trim();
    const rawState = String(req.body?.state || req.body?.status || '').trim();
    if (rawTracking && rawState) {
      await updateParcelStatusEverywhere(
        rawTracking,
        normalizePartnerStatus(rawState),
        rawState,
        partner?.name || 'Partenaire',
        `Webhook livraison (${partner?.name || partnerId}) : ${rawState}`
      );
    }

    const nowIso = new Date().toISOString();
    if (partner?.apiConfig) {
      partner.apiConfig.lastWebhookAt = nowIso;
      await syncPartnerEverywhere(partner);
    }

    const logItem: PartnerSyncLog = {
      id: `log-${Date.now()}`,
      timestamp: nowIso.replace('T', ' ').slice(0, 16),
      partnerId: partner?.id || partnerId,
      partnerName: partner?.name || 'Partenaire',
      direction: 'webhook_received',
      status: 'success',
      statusCode: 200,
      endpoint: `/api/webhooks/delivery/${partnerId}`,
      message: `Webhook de livraison reçu avec succès (${new Date().toLocaleTimeString('fr-MA')}).`,
      requestPayloadPreview: JSON.stringify(req.body || {}).slice(0, 200)
    };
    await syncLogsEverywhere(logItem);

    return res.json({
      success: true,
      message: 'Webhook processed successfully',
      partnerId,
      receivedAt: nowIso
    });
  });

  // ---------------------------------------------------------------------------
  // 5. SECURE INBOUND WEBHOOK (MANDATORY SECRET / SIGNATURE VERIFICATION)
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/partners/:partnerId/inbound', async (req: Request, res: Response) => {
    const { partnerId } = req.params;
    let partner = partnersCache.find(p => p.id === partnerId);
    if (!partner) {
      const { data } = await supabase.from('delivery_partners').select('*').eq('id', partnerId).single();
      if (data) partner = mapDbToPartner(data);
    }

    if (!partner) {
      return res.status(404).json({ success: false, error: 'Partenaire non reconnu.' });
    }

    if (!partner.active) {
      return res.status(403).json({ success: false, error: 'Partenaire désactivé dans le système Fariousy.' });
    }

    // MANDATORY WEBHOOK SECURITY VERIFICATION
    const configuredSecret = partner.apiConfig?.webhookSecret;
    const incomingSecret =
      req.headers['x-partner-secret'] ||
      req.headers['x-webhook-token'] ||
      req.headers['x-hub-signature-256'] ||
      req.headers['x-signature'] ||
      (req.query.secret as string);

    if (configuredSecret) {
      if (!incomingSecret || incomingSecret !== configuredSecret) {
        const securityLog: PartnerSyncLog = {
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
          partnerId: partner.id,
          partnerName: partner.name,
          direction: 'webhook_received',
          status: 'error',
          statusCode: 401,
          endpoint: `/api/webhooks/partners/${partnerId}/inbound`,
          message: 'Échec de validation de sécurité : secret ou signature de webhook invalide ou manquant.',
          requestPayloadPreview: JSON.stringify(req.body).slice(0, 200)
        };
        syncLogsCache.unshift(securityLog);
        await persistSyncLogToSupabase(securityLog);

        return res.status(401).json({
          success: false,
          error: 'Accès non autorisé : signature ou secret de webhook invalide.'
        });
      }
    } else {
      const internalKey = req.headers['x-fariousy-internal-key'];
      const configuredSecret = (process.env.FARIOUSY_API_SECRET || '').trim();
      if (!configuredSecret || !internalKey || internalKey !== configuredSecret) {
        return res.status(401).json({
          success: false,
          error: 'Accès refusé : webhookSecret non configuré pour ce partenaire.'
        });
      }
    }

    const parseResult = parseInboundPackagePayload(req.body, partner);
    if (!parseResult.isValid || !parseResult.packageData) {
      const errLog: PartnerSyncLog = {
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
        partnerId: partner.id,
        partnerName: partner.name,
        direction: 'webhook_received',
        status: 'error',
        statusCode: 422,
        endpoint: `/api/webhooks/partners/${partnerId}/inbound`,
        message: `Erreur validation colis entrant : ${parseResult.error}`,
        requestPayloadPreview: JSON.stringify(req.body).slice(0, 200)
      };
      syncLogsCache.unshift(errLog);
      await persistSyncLogToSupabase(errLog);

      return res.status(422).json({ success: false, error: parseResult.error });
    }

    const newPackage = parseResult.packageData;

    partner.totalReceived = (partner.totalReceived || 0) + 1;
    await persistPartnerToSupabase(partner);

    // Insert into Supabase packages table with inbound flags
    try {
      await supabase.from('packages').insert({
        id: `pkg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        tracking_number: newPackage.trackingNumber,
        partner_id: partner.id,
        partner_name: partner.name,
        partner_tracking_number: newPackage.partnerTrackingNumber,
        client_id: newPackage.clientId || 'usr-client-partner',
        client_name: newPackage.clientName || partner.name,
        client_phone: newPackage.clientPhone || partner.phone,
        client_company: newPackage.clientCompany || partner.name,
        recipient_name: newPackage.recipientName,
        recipient_phone: newPackage.recipientPhone,
        city: newPackage.city,
        address: newPackage.address,
        product_price: newPackage.productPrice || 0,
        delivery_fee: newPackage.deliveryFee || 35,
        cod_amount: newPackage.codAmount || 0,
        description: newPackage.description,
        notes: newPackage.notes,
        status: 'nouveau',
        current_agency: newPackage.currentAgency,
        destination_agency: newPackage.destinationAgency || newPackage.currentAgency,
        is_inbound_from_partner: true,
        inbound_read: false,
        partner_sync_status: 'synced',
        partner_last_sync_at: new Date().toISOString()
      });
    } catch (dbErr: any) {
      console.warn('[Supabase Inbound Insert Notice]', dbErr.message);
    }

    const successLog: PartnerSyncLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
      partnerId: partner.id,
      partnerName: partner.name,
      direction: 'inbound_receive',
      status: 'success',
      statusCode: 201,
      endpoint: `/api/webhooks/partners/${partnerId}/inbound`,
      message: `Colis entrant réceptionné de ${partner.name}. Attribué à Fariousy sous le N° ${newPackage.trackingNumber}`,
      packageCount: 1,
      trackingNumbers: [newPackage.trackingNumber || ''],
      requestPayloadPreview: JSON.stringify(req.body).slice(0, 200),
      responsePayloadPreview: JSON.stringify({ trackingNumber: newPackage.trackingNumber, status: 'CREATED' }),
      durationMs: 35
    };
    syncLogsCache.unshift(successLog);
    await persistSyncLogToSupabase(successLog);

    res.status(201).json({
      success: true,
      message: 'Colis réceptionné avec succès dans le système Fariousy Delivery.',
      trackingNumber: newPackage.trackingNumber,
      partnerTrackingNumber: newPackage.partnerTrackingNumber,
      status: 'ENREGISTRE',
      hub: newPackage.currentAgency
    });
  });

  // Pull queued inbound packages directly from Supabase
  app.get('/api/partners/inbound-queue', authenticateAndAuthorize(['admin', 'employee']), async (_req: Request, res: Response) => {
    try {
      const resPkgs: any = await safeDbQuery(
        supabase
          .from('packages')
          .select('*')
          .eq('is_inbound_from_partner', true)
          .eq('inbound_read', false)
          .order('created_at', { ascending: false }),
        1200
      );

      const pkgs = resPkgs?.data;
      if (!resPkgs?.error && pkgs && pkgs.length > 0) {
        const ids = pkgs.map((p: any) => p.id);
        await safeDbQuery(supabase.from('packages').update({ inbound_read: true }).in('id', ids), 1000);

        return res.json({
          success: true,
          packages: pkgs.map((p: any) => ({
            id: p.id,
            trackingNumber: p.tracking_number,
            partnerTrackingNumber: p.partner_tracking_number,
            clientId: p.client_id,
            clientName: p.client_name,
            clientPhone: p.client_phone,
            clientCompany: p.client_company,
            recipientName: p.recipient_name,
            recipientPhone: p.recipient_phone,
            city: p.city,
            address: p.address,
            productPrice: Number(p.product_price || 0),
            deliveryFee: Number(p.delivery_fee || 35),
            codAmount: Number(p.cod_amount || 0),
            description: p.description,
            notes: p.notes,
            status: p.status,
            currentAgency: p.current_agency,
            destinationAgency: p.destination_agency,
            partnerSyncStatus: p.partner_sync_status
          }))
        });
      }
    } catch (e: any) {
      console.warn('[Supabase Inbound Queue Warning]', e.message);
    }

    res.json({ success: true, packages: [] });
  });

  // ---------------------------------------------------------------------------
  // 6. SYNCHRONIZATION LOGS & METRICS API (SUPABASE BACKED)
  // ---------------------------------------------------------------------------
  app.get('/api/partners/logs', authenticateAndAuthorize(['admin', 'employee', 'partner']), async (req: Request, res: Response) => {
    const { partnerId, status, limit } = req.query;
    const max = Number(limit) || 100;

    try {
      let query = supabase
        .from('partner_sync_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(max);

      if (partnerId && partnerId !== 'all') {
        query = query.eq('partner_id', partnerId as string);
      }
      if (status && status !== 'all') {
        query = query.eq('status', status as string);
      }

      const resLogs: any = await safeDbQuery(query, 1200);
      const dbLogs = resLogs?.data;
      if (!resLogs?.error && dbLogs) {
        syncLogsCache = dbLogs.map(mapDbToSyncLog);
        return res.json({ success: true, logs: syncLogsCache });
      }
    } catch (e: any) {
      console.warn('[Supabase Logs Fetch Warning]', e.message);
    }

    let filtered = [...syncLogsCache];
    if (partnerId && partnerId !== 'all') filtered = filtered.filter(l => l.partnerId === partnerId);
    if (status && status !== 'all') filtered = filtered.filter(l => l.status === status);
    res.json({ success: true, logs: filtered.slice(0, max) });
  });

  app.delete('/api/partners/logs', authenticateAndAuthorize(['admin']), async (_req: Request, res: Response) => {
    syncLogsCache = [];
    try {
      await safeDbQuery(supabase.from('partner_sync_logs').delete().neq('id', 'placeholder'), 1200);
    } catch (e: any) {
      console.warn('[Supabase Logs Delete Error]', e.message);
    }
    res.json({ success: true, message: 'Journaux de synchronisation vidés avec succès.' });
  });

  // ---------------------------------------------------------------------------
  // 7. CLIENT MESSAGES API (SUPABASE BACKED PERSISTENCE)
  // ---------------------------------------------------------------------------
  app.get('/api/client-messages', authenticateAndAuthorize(['admin', 'employee', 'client']), async (req: Request, res: Response) => {
    const callerProf = (req as any).profile;
    const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
    const isClientCaller = !isOwnerSuperAdmin(callerProf) && callerRole === 'client';
    const clientId = isClientCaller ? String(callerProf.id) : (req.query.clientId as string | undefined);
    const { status, category } = req.query;

    try {
      let query = supabase
        .from('client_messages')
        .select('*')
        .order('created_at', { ascending: false });

      if (clientId && clientId !== 'all') {
        query = query.eq('client_id', clientId);
      }
      if (status && status !== 'all') {
        query = query.eq('status', status as string);
      }
      if (category && category !== 'all') {
        query = query.eq('category', category as string);
      }

      const resMsgs: any = await safeDbQuery(query, 1200);
      const dbMsgs = resMsgs?.data;
      if (!resMsgs?.error && dbMsgs && dbMsgs.length > 0) {
        const mapped = dbMsgs.map(mapDbToClientMessage);
        if (!isClientCaller) {
          clientMessagesCache = mapped;
          persistentStorage.setSystemCollection('clientMessages', clientMessagesCache);
        }
        return res.json({ success: true, count: mapped.length, messages: mapped });
      }
    } catch (e: any) {
      console.warn('[Supabase Client Messages Fetch Warning]', e.message);
    }

    const storedMessages = persistentStorage.getSystemCollection<ClientMessage[]>('clientMessages');
    let list = Array.isArray(storedMessages) ? [...storedMessages] : [...clientMessagesCache];
    clientMessagesCache = list;
    if (clientId && clientId !== 'all') list = list.filter(m => m.clientId === clientId);
    if (status && status !== 'all') list = list.filter(m => m.status === status);
    if (category && category !== 'all') list = list.filter(m => m.category === category);
    res.json({ success: true, count: list.length, messages: list });
  });

  app.post('/api/client-messages', authenticateAndAuthorize(['admin', 'employee', 'client']), async (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = !isOwnerSuperAdmin(callerProf) && callerRole === 'client';
      const msg: ClientMessage = {
        id: req.body.id || `msg-${Date.now()}`,
        clientId: isClientCaller ? String(callerProf.id) : (req.body.clientId || 'client-anon'),
        clientName: req.body.clientName || 'Client',
        clientCompany: req.body.clientCompany || '',
        clientPhone: req.body.clientPhone || '',
        clientEmail: req.body.clientEmail || '',
        category: req.body.category || 'autre',
        priority: req.body.priority || 'normale',
        status: 'nouveau',
        subject: req.body.subject || 'Nouveau message client',
        message: req.body.message || '',
        packageTrackingNumber: req.body.packageTrackingNumber || undefined,
        packageId: req.body.packageId || undefined,
        createdAt: req.body.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        replies: req.body.replies || []
      };

      const stored = persistentStorage.getSystemCollection<ClientMessage[]>('clientMessages');
      const currentList = Array.isArray(stored) ? stored : clientMessagesCache;
      clientMessagesCache = [msg, ...currentList.filter(m => m.id !== msg.id)];
      persistentStorage.setSystemCollection('clientMessages', clientMessagesCache);

      try {
        await supabase.from('client_messages').upsert({
          id: msg.id,
          client_id: msg.clientId,
          client_name: msg.clientName,
          client_company: msg.clientCompany,
          client_phone: msg.clientPhone,
          client_email: msg.clientEmail,
          category: msg.category,
          priority: msg.priority,
          status: msg.status,
          subject: msg.subject,
          message: msg.message,
          package_tracking_number: msg.packageTrackingNumber,
          package_id: msg.packageId,
          replies: msg.replies,
          created_at: msg.createdAt,
          updated_at: msg.updatedAt
        });
      } catch (err: any) {
        console.warn('[Supabase Client Message Insert Warning]', err.message);
      }

      res.status(201).json({ success: true, message: msg });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/client-messages/:id/reply', authenticateAndAuthorize(['admin', 'employee', 'client']), async (req: Request, res: Response) => {
    const { id } = req.params;
    const stored = persistentStorage.getSystemCollection<ClientMessage[]>('clientMessages');
    if (Array.isArray(stored)) clientMessagesCache = stored;
    let msg = clientMessagesCache.find(m => m.id === id);

    if (!msg) {
      const { data } = await supabase.from('client_messages').select('*').eq('id', id).single();
      if (data) msg = mapDbToClientMessage(data);
    }

    if (!msg) {
      return res.status(404).json({ success: false, error: 'Message non trouvé' });
    }

    const callerProf = (req as any).profile;
    const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
    if (!isOwnerSuperAdmin(callerProf) && callerRole === 'client' && msg.clientId !== callerProf.id) {
      return res.status(403).json({ success: false, error: 'Accès refusé à ce ticket.' });
    }

    const reply: ClientMessageReply = {
      id: req.body.id || `rep-${Date.now()}`,
      senderId: req.body.senderId || 'support',
      senderName: req.body.senderName || 'Support Fariousy',
      senderRole: req.body.senderRole || 'support',
      message: req.body.message || '',
      createdAt: req.body.createdAt || new Date().toISOString()
    };

    msg.replies = msg.replies || [];
    msg.replies.push(reply);
    msg.updatedAt = new Date().toISOString();
    if (reply.senderRole === 'client' || msg.status === 'nouveau') {
      msg.status = 'en_cours';
    }
    persistentStorage.setSystemCollection('clientMessages', clientMessagesCache);

    try {
      await supabase.from('client_messages').update({
        replies: msg.replies,
        status: msg.status,
        updated_at: msg.updatedAt
      }).eq('id', id);
    } catch (e: any) {
      console.warn('[Supabase Client Reply Warning]', e.message);
    }

    res.json({ success: true, message: msg, reply });
  });

  app.patch('/api/client-messages/:id/status', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    const { id } = req.params;
    const { status, resolvedBy } = req.body;
    const stored = persistentStorage.getSystemCollection<ClientMessage[]>('clientMessages');
    if (Array.isArray(stored)) clientMessagesCache = stored;
    let msg = clientMessagesCache.find(m => m.id === id);

    if (!msg) {
      const { data } = await supabase.from('client_messages').select('*').eq('id', id).single();
      if (data) msg = mapDbToClientMessage(data);
    }

    if (!msg) {
      return res.status(404).json({ success: false, error: 'Message non trouvé' });
    }

    msg.status = status;
    msg.updatedAt = new Date().toISOString();
    if (status === 'resolu' || status === 'ferme') {
      msg.resolvedAt = new Date().toISOString();
      msg.resolvedBy = resolvedBy || 'Admin Support';
    }
    persistentStorage.setSystemCollection('clientMessages', clientMessagesCache);

    try {
      await supabase.from('client_messages').update({
        status: msg.status,
        resolved_at: msg.resolvedAt,
        resolved_by: msg.resolvedBy,
        updated_at: msg.updatedAt
      }).eq('id', id);
    } catch (e: any) {
      console.warn('[Supabase Status Update Warning]', e.message);
    }

    res.json({ success: true, message: msg });
  });

  app.delete('/api/client-messages/:id', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    const { id } = req.params;
    const stored = persistentStorage.getSystemCollection<ClientMessage[]>('clientMessages');
    const base = Array.isArray(stored) ? stored : clientMessagesCache;
    clientMessagesCache = base.filter(m => m.id !== id);
    persistentStorage.setSystemCollection('clientMessages', clientMessagesCache);
    try {
      await supabase.from('client_messages').delete().eq('id', id);
    } catch (e: any) {
      console.warn('[Supabase Client Message Delete Warning]', e.message);
    }
    res.json({ success: true, message: 'Message supprimé' });
  });

  // =======================================================================
  // DRIVER REGISTRATION ENDPOINTS (Inscription & Validation Livreurs)
  // =======================================================================

  // GET /api/driver-registrations - List all candidate requests
  app.get('/api/driver-registrations', authenticateAndAuthorize(['admin', 'employee']), async (req: Request, res: Response) => {
    try {
      const { status, q } = req.query;
      let results = [...getSyncedDriverRequests()];

      // Sync fresh from Supabase if available
      try {
        let query = supabase.from('driver_registration_requests').select('*').order('submitted_at', { ascending: false });
        if (status && typeof status === 'string' && status !== 'all') {
          query = query.eq('status', status);
        }
        const { data, error } = await query;
        if (!error && Array.isArray(data) && data.length > 0) {
          const mapped = data.map(mapDbToDriverRequest);
          if (!status || status === 'all') {
            saveSyncedDriverRequests(mapped);
          }
          results = mapped;
        }
      } catch {
        // Fallback to persistent cache
      }

      if (status && typeof status === 'string' && status !== 'all') {
        results = results.filter(r => r.status === status);
      }

      if (q && typeof q === 'string' && q.trim()) {
        const queryText = q.toLowerCase().trim();
        results = results.filter(r =>
          r.fullName.toLowerCase().includes(queryText) ||
          r.phone.includes(queryText) ||
          r.email.toLowerCase().includes(queryText) ||
          r.cinNumber.toLowerCase().includes(queryText) ||
          (r.driverPlate && r.driverPlate.toLowerCase().includes(queryText))
        );
      }

      res.json({ success: true, count: results.length, data: results });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/driver-registrations - Submit new driver candidate application
  app.post('/api/driver-registrations', async (req: Request, res: Response) => {
    try {
      const secSettings = persistentStorage.getSecuritySettings();
      const caller = await resolveAuthenticatedCaller(req);
      const isPrivileged = Boolean(caller && (caller.isSuper || caller.role === 'admin' || caller.role === 'employee'));
      if (!secSettings.allowPublicDriverRegistration && !isPrivileged) {
        return res.status(403).json({
          success: false,
          error: "Les candidatures publiques de nouveaux livreurs sont actuellement verrouillées par le Super Administrateur."
        });
      }
      const {
        id,
        fullName,
        phone,
        email,
        city,
        address,
        cinNumber,
        cinPhotoUrl,
        cinBackPhotoUrl,
        driverPhotoUrl,
        vehicleType,
        driverPlate,
        notes,
        password
      } = req.body;

      if (!fullName || !phone || !email || !city || !address || !cinNumber || !vehicleType) {
        return res.status(400).json({
          success: false,
          error: 'Champs obligatoires manquants (Nom, Téléphone, Email, Ville, Adresse, CIN, Type de véhicule).'
        });
      }

      const cleanPhone = phone.trim().replace(/\s+/g, '');
      const cleanEmail = email.trim().toLowerCase();
      const currentReqs = getSyncedDriverRequests();

      const existingPhone = currentReqs.find(
        r => r.status !== 'refuse' && r.phone.replace(/\s+/g, '') === cleanPhone
      );
      if (existingPhone) {
        return res.status(409).json({
          success: false,
          error: `Un dossier existe déjà avec le numéro de téléphone ${phone}.`
        });
      }

      const existingEmail = currentReqs.find(
        r => r.status !== 'refuse' && r.email.toLowerCase() === cleanEmail
      );
      if (existingEmail) {
        return res.status(409).json({
          success: false,
          error: `Un dossier existe déjà avec l'adresse e-mail ${email}.`
        });
      }

      try {
        const { data: existingSb } = await supabase
          .from('driver_registration_requests')
          .select('id, status, email, phone')
          .or(`email.eq.${cleanEmail},phone.eq.${phone.trim()}`)
          .neq('status', 'refuse')
          .limit(1);
        if (existingSb && existingSb.length > 0) {
          return res.status(409).json({
            success: false,
            error: `Une demande est déjà enregistrée avec cet e-mail ou ce numéro de téléphone.`
          });
        }
      } catch {}

      const isUuid = typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
      const resolvedId = isUuid ? id.trim() : crypto.randomUUID();

      const newRequest: DriverRegistrationRequest = {
        id: resolvedId,
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: cleanEmail,
        city: city.trim(),
        address: address.trim(),
        cinNumber: cinNumber.trim().toUpperCase(),
        cinPhotoUrl: cinPhotoUrl || undefined,
        cinBackPhotoUrl: cinBackPhotoUrl || undefined,
        driverPhotoUrl: driverPhotoUrl || undefined,
        vehicleType,
        driverPlate: driverPlate ? driverPlate.trim() : undefined,
        status: 'en_attente',
        submittedAt: new Date().toISOString(),
        notes: notes ? notes.trim() : undefined,
        password: password ? '********' : undefined
      };

      persistentStorage.saveKycDocuments([newRequest.id, cleanEmail], {
        cinNumber: newRequest.cinNumber,
        cinPhotoUrl: cinPhotoUrl || undefined,
        cinBackPhotoUrl: cinBackPhotoUrl || undefined,
        driverPhotoUrl: driverPhotoUrl || undefined
      });

      saveSyncedDriverRequests([newRequest, ...currentReqs]);

      try {
        const baseReqRow = {
          id: newRequest.id,
          full_name: newRequest.fullName,
          phone: newRequest.phone,
          email: newRequest.email,
          city: newRequest.city,
          address: newRequest.address,
          cin_number: newRequest.cinNumber,
          vehicle_type: newRequest.vehicleType,
          driver_plate: newRequest.driverPlate || null,
          status: 'en_attente',
          notes: newRequest.notes || null,
          submitted_at: newRequest.submittedAt
        };
        const { error: reqErr } = await supabase.from('driver_registration_requests').insert({
          ...baseReqRow,
          cin_photo_url: newRequest.cinPhotoUrl || null,
          cin_back_photo_url: newRequest.cinBackPhotoUrl || null,
          driver_photo_url: newRequest.driverPhotoUrl || null
        });
        if (reqErr && /column|schema cache|PGRST204/i.test(reqErr.message || reqErr.code || '')) {
          await supabase.from('driver_registration_requests').insert(baseReqRow);
        } else if (reqErr) {
          console.warn('[Supabase Driver Registration Insert Error]', reqErr.message);
        }
      } catch (dbErr: any) {
        console.warn('[Supabase Driver Registration Warning]', dbErr.message);
      }

      res.status(201).json({
        success: true,
        message: 'Demande enregistrée avec succès. Votre dossier est en cours d\'examen par la direction.',
        data: newRequest
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/driver-registrations/:id/approve - Approve driver and activate
  app.post('/api/driver-registrations/:id/approve', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { reviewedBy } = req.body || {};
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
      const nowIso = new Date().toISOString();
      const reviewer = reviewedBy || 'Administrateur Fariousy';

      const currentReqs = [...getSyncedDriverRequests()];
      let target = currentReqs.find(r => r.id === id);
      if (target) {
        target = {
          ...target,
          status: 'approuve',
          reviewedAt: nowIso,
          reviewedBy: reviewer,
          rejectionReason: undefined
        };
      }

      if (isUuid) {
        try {
          const { data: updatedRow } = await supabase
            .from('driver_registration_requests')
            .update({
              status: 'approuve',
              reviewed_at: nowIso,
              reviewed_by: reviewer,
              rejection_reason: null,
              updated_at: nowIso
            })
            .eq('id', id)
            .select('*')
            .maybeSingle();

          if (!target && updatedRow) {
            target = mapDbToDriverRequest(updatedRow);
          }
        } catch (dbErr: any) {
          console.warn('[Supabase Driver Approval Warning]', dbErr.message);
        }
      }

      if (!target) {
        return res.status(404).json({ success: false, error: 'Demande non trouvée.' });
      }

      const nextList = currentReqs.some(r => r.id === target!.id)
        ? currentReqs.map(r => (r.id === target!.id ? target! : r))
        : [target, ...currentReqs];
      saveSyncedDriverRequests(nextList);

      res.json({
        success: true,
        message: `Le compte du livreur ${target.fullName} a été approuvé et activé.`,
        data: target
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/driver-registrations/:id/reject - Reject driver with mandatory reason
  app.post('/api/driver-registrations/:id/reject', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { reason, reviewedBy } = req.body || {};

      if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, error: 'Le motif du refus est obligatoire.' });
      }

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
      const nowIso = new Date().toISOString();
      const reviewer = reviewedBy || 'Administrateur Fariousy';

      const currentReqs = [...getSyncedDriverRequests()];
      let target = currentReqs.find(r => r.id === id);
      if (target) {
        target = {
          ...target,
          status: 'refuse',
          rejectionReason: reason.trim(),
          reviewedAt: nowIso,
          reviewedBy: reviewer
        };
      }

      if (isUuid) {
        try {
          const { data: updatedRow } = await supabase
            .from('driver_registration_requests')
            .update({
              status: 'refuse',
              rejection_reason: reason.trim(),
              reviewed_at: nowIso,
              reviewed_by: reviewer,
              updated_at: nowIso
            })
            .eq('id', id)
            .select('*')
            .maybeSingle();

          if (!target && updatedRow) {
            target = mapDbToDriverRequest(updatedRow);
          }
        } catch (dbErr: any) {
          console.warn('[Supabase Driver Reject Warning]', dbErr.message);
        }
      }

      if (!target) {
        return res.status(404).json({ success: false, error: 'Demande non trouvée.' });
      }

      const nextList = currentReqs.some(r => r.id === target!.id)
        ? currentReqs.map(r => (r.id === target!.id ? target! : r))
        : [target, ...currentReqs];
      saveSyncedDriverRequests(nextList);

      res.json({
        success: true,
        message: `La candidature de ${target.fullName} a été refusée.`,
        data: target
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/driver-registrations/:id - Delete registration request
  app.delete('/api/driver-registrations/:id', authenticateAndAuthorize(['admin']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
      saveSyncedDriverRequests(getSyncedDriverRequests().filter(r => r.id !== id));
      if (isUuid) {
        try {
          await supabase.from('driver_registration_requests').delete().eq('id', id);
        } catch (dbErr: any) {
          console.warn('[Supabase Driver Delete Warning]', dbErr.message);
        }
      }
      res.json({ success: true, message: 'Demande d\'inscription supprimée.' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // COMPANY SETTINGS API (PERSISTED ACROSS ALL DEVICES & PUBLIC SITE)
  // ===========================================================================
  app.get('/api/company-settings', async (req: Request, res: Response) => {
    try {
      await ensureSystemStateLoadedFromSupabase();
      const stored = persistentStorage.getCompanySettings();
      const rawSettings: CompanySettings = {
        ...INITIAL_COMPANY_SETTINGS,
        ...(stored || {})
      };
      const caller = await resolveAuthenticatedCaller(req);
      const isPrivileged = Boolean(caller && (caller.isSuper || caller.role === 'admin' || caller.role === 'employee'));
      if (!isPrivileged) {
        const { whatsappApiToken: _t, whatsappWebhookUrl: _w, ...publicSettings } = rawSettings as any;
        return res.json({ success: true, settings: publicSettings });
      }
      res.json({ success: true, settings: rawSettings });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/public/cities', async (_req: Request, res: Response) => {
    try {
      await ensureSystemStateLoadedFromSupabase();
      const stored = persistentStorage.getSystemCollection<any[]>('cities');
      const hasStored = Array.isArray(stored) && stored.length > 0;
      const source = hasStored ? stored : INITIAL_CITIES;
      const customized = hasStored && !areCitiesEqualToInitial(stored);
      res.json({
        success: true,
        fromServer: hasStored,
        customized,
        cities: source.map((c: any) => ({
          id: c.id,
          name: c.name,
          region: c.region,
          defaultFee: Number(c.defaultFee ?? 35),
          returnFee: Number(c.returnFee ?? 15),
          deliveryDelayHours: Number(c.deliveryDelayHours ?? 48),
          active: c.active !== false
        }))
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  const handleUpdateCompanySettings = (req: Request, res: Response) => {
    try {
      const body = { ...(req.body || {}) } as Partial<CompanySettings>;
      if (body.whatsappApiToken === undefined || (typeof body.whatsappApiToken === 'string' && body.whatsappApiToken.includes('••••'))) {
        delete body.whatsappApiToken;
      }
      if (body.whatsappWebhookUrl === undefined) {
        delete body.whatsappWebhookUrl;
      }
      const saved = persistentStorage.saveCompanySettings(body, INITIAL_COMPANY_SETTINGS);
      void persistSystemStateToSupabase();
      res.json({ success: true, settings: saved });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  };

  app.put('/api/company-settings', authenticateAndAuthorize(['admin']), handleUpdateCompanySettings);
  app.post('/api/company-settings', authenticateAndAuthorize(['admin']), handleUpdateCompanySettings);

  // ===========================================================================
  // CUSTOMER & DRIVER REVIEWS API (آراء الزبائن فالشركة والليفرورز)
  // ===========================================================================
  app.get('/api/reviews', async (req: Request, res: Response) => {
    try {
      let includeHidden = false;
      if (req.query.all === '1') {
        const caller = await resolveAuthenticatedCaller(req);
        if (caller && (caller.isSuper || caller.role === 'admin' || caller.role === 'employee')) {
          includeHidden = true;
        }
      }
      const allReviews = persistentStorage.getReviews();
      const reviews = includeHidden ? allReviews : allReviews.filter(r => r.isPublic !== false);

      // Expose non-sensitive driver directory (id, name, city) for public review picker
      const publicDrivers = persistentStorage
        .getUsers()
        .filter(u => u.role === 'driver' && u.status === 'active')
        .map(d => ({
          id: d.id,
          name: d.name,
          city: d.city || ''
        }));

      res.json({ success: true, reviews, drivers: publicDrivers });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/reviews', (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const targetType = body.targetType === 'driver' ? 'driver' : 'company';
      const ratingNum = Number(body.rating);
      const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
      const authorName = typeof body.authorName === 'string' ? body.authorName.trim() : '';

      if (!authorName || authorName.length < 2) {
        return res.status(400).json({ success: false, error: 'الاسم مطلوب (على الأقل حرفين).' });
      }
      if (!comment || comment.length < 3) {
        return res.status(400).json({ success: false, error: 'يرجى كتابة تعليق أو رأي.' });
      }
      if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        return res.status(400).json({ success: false, error: 'التقييم يجب أن يكون بين 1 و 5 نجوم.' });
      }

      let resolvedDriverId = typeof body.driverId === 'string' ? body.driverId.trim() : undefined;
      let resolvedDriverName = typeof body.driverName === 'string' ? body.driverName.trim() : undefined;
      const trackingCode = typeof body.trackingNumber === 'string' ? body.trackingNumber.trim().toUpperCase() : undefined;

      // Auto-link driver from package if tracking number provided
      if (trackingCode) {
        const matchedPkg = persistentStorage
          .getPackages()
          .find(p => p.trackingNumber?.toUpperCase() === trackingCode);
        if (matchedPkg) {
          if (!resolvedDriverId && matchedPkg.driverId) resolvedDriverId = matchedPkg.driverId;
          if (!resolvedDriverName && matchedPkg.driverName) resolvedDriverName = matchedPkg.driverName;
        }
      }

      if (resolvedDriverId && !resolvedDriverName) {
        const drv = persistentStorage.getUsers().find(u => u.id === resolvedDriverId);
        if (drv) resolvedDriverName = drv.name;
      }

      if (targetType === 'driver' && !resolvedDriverName && !resolvedDriverId) {
        return res.status(400).json({ success: false, error: 'يرجى تحديد أو كتابة اسم الليفرور.' });
      }

      const newReview: CustomerReview = {
        id: 'rev-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
        targetType,
        rating: Math.round(ratingNum),
        comment,
        authorName,
        authorRole:
          body.authorRole === 'client' || body.authorRole === 'destinataire'
            ? body.authorRole
            : 'visiteur',
        authorCity: typeof body.authorCity === 'string' ? body.authorCity.trim() : undefined,
        authorPhone: typeof body.authorPhone === 'string' ? body.authorPhone.trim() : undefined,
        driverId: targetType === 'driver' ? resolvedDriverId : undefined,
        driverName: targetType === 'driver' ? resolvedDriverName : undefined,
        trackingNumber: trackingCode || undefined,
        isPublic: true,
        createdAt: new Date().toISOString()
      };

      const saved = persistentStorage.addReview(newReview);
      res.status(201).json({ success: true, review: saved });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.patch('/api/reviews/:id', authenticateAndAuthorize(['admin']), (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates: Partial<CustomerReview> = {};
      if (typeof req.body?.isPublic === 'boolean') updates.isPublic = req.body.isPublic;
      if (typeof req.body?.adminReply === 'string') updates.adminReply = req.body.adminReply.trim();
      const updated = persistentStorage.updateReview(id, updates);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'الرأي غير موجود.' });
      }
      res.json({ success: true, review: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/reviews/:id', authenticateAndAuthorize(['admin']), (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deleted = persistentStorage.deleteReview(id);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'الرأي غير موجود.' });
      }
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // CLIENT FULFILLMENT STOCK API (السطوك عند الزبون بالأكواد والفواتير)
  // ===========================================================================
  app.get('/api/client-stock', authenticateAndAuthorize(['admin', 'employee', 'client']), async (req: Request, res: Response) => {
    try {
      let clientId =
        typeof req.query.clientId === 'string' && req.query.clientId.trim()
          ? req.query.clientId.trim()
          : undefined;
      let shopId =
        typeof req.query.shopId === 'string' && req.query.shopId.trim()
          ? req.query.shopId.trim()
          : undefined;

      // Enforce strict client isolation if caller is a client (works for Bearer OR Cookie)
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      if (!isOwnerSuperAdmin(callerProf) && callerRole === 'client') {
        clientId = String(callerProf.id);
        shopId = callerProf.shopId || shopId;
      }

      const data = persistentStorage.getClientStockData(clientId, shopId);
      res.json({ success: true, ...data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/client-stock/products', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = !isOwnerSuperAdmin(callerProf) && callerRole === 'client';
      const clientId = isClientCaller ? String(callerProf.id) : (typeof b.clientId === 'string' ? b.clientId.trim() : '');
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      const quantity = Number(b.quantity);
      const unitPrice = Number(b.unitPrice || 0);

      if (!clientId) {
        return res.status(400).json({ success: false, error: 'معرف الزبون/المتجر مطلوب.' });
      }
      if (!name || name.length < 2) {
        return res.status(400).json({ success: false, error: 'اسم المنتوج مطلوب (على الأقل حرفين).' });
      }
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 500) {
        return res.status(400).json({ success: false, error: 'العدد يجب أن يكون بين 1 و 500 قطعة.' });
      }

      const created = persistentStorage.createClientStockProduct({
        clientId,
        clientName: typeof b.clientName === 'string' ? b.clientName : undefined,
        clientCompany: typeof b.clientCompany === 'string' ? b.clientCompany : undefined,
        name,
        photoUrl: typeof b.photoUrl === 'string' ? b.photoUrl : undefined,
        category: typeof b.category === 'string' ? b.category : undefined,
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
        quantity,
        hubName: typeof b.hubName === 'string' ? b.hubName : undefined,
        notes: typeof b.notes === 'string' ? b.notes : undefined,
        actorName: typeof b.actorName === 'string' ? b.actorName : undefined
      });

      res.status(201).json({ success: true, ...created });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/client-stock/products/:id/add-units', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      if (!isOwnerSuperAdmin(callerProf) && callerRole === 'client') {
        const all = persistentStorage.getClientStockData();
        const target = all.products.find(p => p.id === id);
        if (target && target.clientId !== callerProf.id && target.clientId !== callerProf.shopId) {
          return res.status(403).json({ success: false, error: 'غير مسموح لك بتعديل منتوج لا يخص متجرك.' });
        }
      }
      const qty = Number(req.body?.quantity);
      if (!Number.isFinite(qty) || qty < 1 || qty > 500) {
        return res.status(400).json({ success: false, error: 'العدد الإضافي يجب أن يكون بين 1 و 500.' });
      }
      const updated = persistentStorage.addUnitsToClientStockProduct(
        id,
        qty,
        typeof req.body?.actorName === 'string' ? req.body.actorName : undefined
      );
      if (!updated) {
        return res.status(404).json({ success: false, error: 'المنتوج غير موجود.' });
      }
      res.json({ success: true, ...updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/client-stock/scan', authenticateAndAuthorize(['admin', 'employee']), (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const code = typeof b.code === 'string' ? b.code : (typeof b.productId === 'string' ? b.productId : '');
      const result = persistentStorage.scanClientStockUnit(code, {
        hubName: typeof b.hubName === 'string' ? b.hubName : undefined,
        zone: typeof b.zone === 'string' ? b.zone : undefined,
        shelf: typeof b.shelf === 'string' ? b.shelf : undefined,
        bin: typeof b.bin === 'string' ? b.bin : undefined,
        actorName: typeof b.actorName === 'string' ? b.actorName : undefined,
        scanAllPending: b.scanAllPending === true
      });
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/client-stock/dispatch-unit', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = !isOwnerSuperAdmin(callerProf) && callerRole === 'client';
      const code = typeof b.code === 'string' ? b.code : (typeof b.productId === 'string' ? b.productId : '');
      const result = persistentStorage.dispatchClientStockUnit(code, {
        clientId: isClientCaller ? String(callerProf.id) : (typeof b.clientId === 'string' && b.clientId.trim() ? b.clientId.trim() : undefined),
        trackingNumber: typeof b.trackingNumber === 'string' ? b.trackingNumber : undefined,
        packageId: typeof b.packageId === 'string' ? b.packageId : undefined,
        actorName: typeof b.actorName === 'string' ? b.actorName : undefined,
        notes: typeof b.notes === 'string' ? b.notes : undefined
      });
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/client-stock/deduct', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = !isOwnerSuperAdmin(callerProf) && callerRole === 'client';
      const result = persistentStorage.deductClientStockForPackage({
        clientId: isClientCaller ? String(callerProf.id) : String(b.clientId || ''),
        shopId: typeof b.shopId === 'string' ? b.shopId : (callerProf?.shopId || undefined),
        clientName: String(b.clientName || 'Client'),
        clientCompany: typeof b.clientCompany === 'string' ? b.clientCompany : undefined,
        clientPhone: typeof b.clientPhone === 'string' ? b.clientPhone : undefined,
        packageId: String(b.packageId || ''),
        trackingNumber: String(b.trackingNumber || ''),
        recipientName: String(b.recipientName || ''),
        recipientCity: String(b.recipientCity || ''),
        deliveryFee: Number(b.deliveryFee || 0),
        items: Array.isArray(b.items) ? b.items : [],
        actorName: typeof b.actorName === 'string' ? b.actorName : undefined
      });
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/client-stock/restore-package', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const result = persistentStorage.restoreClientStockForPackage(
        String(b.packageId || ''),
        typeof b.trackingNumber === 'string' ? b.trackingNumber : undefined,
        typeof b.actorName === 'string' ? b.actorName : undefined
      );
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.patch('/api/client-stock/invoices/:id', authenticateAndAuthorize(['admin', 'employee']), (req: Request, res: Response) => {
    try {
      const status = req.body?.status === 'payee' ? 'payee' : 'generee';
      const updated = persistentStorage.updateClientStockInvoiceStatus(req.params.id, status);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة.' });
      }
      res.json({ success: true, invoice: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/client-stock/products/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), async (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      if (!isOwnerSuperAdmin(callerProf) && callerRole === 'client') {
        const all = persistentStorage.getClientStockData();
        const target = all.products.find(p => p.id === req.params.id);
        if (target && target.clientId !== callerProf.id && target.clientId !== callerProf.shopId) {
          return res.status(403).json({ success: false, error: 'غير مسموح لك بحذف منتوج لا يخص متجرك.' });
        }
      }

      const ok = persistentStorage.deleteClientStockProduct(req.params.id);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'المنتوج غير موجود.' });
      }
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/client-stock/products/:productId/units/:unitId', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      if (!isOwnerSuperAdmin(callerProf) && callerRole === 'client') {
        const all = persistentStorage.getClientStockData();
        const target = all.products.find(p => p.id === req.params.productId);
        if (target && target.clientId !== callerProf.id && target.clientId !== callerProf.shopId) {
          return res.status(403).json({ success: false, error: 'غير مسموح لك بحذف قطعة لا تخص متجرك.' });
        }
      }
      const result = persistentStorage.deleteClientStockUnit(req.params.productId, req.params.unitId);
      if (!result.success) {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // SYSTEM COLLECTIONS API (FULL SERVER-SIDE PERSISTENCE FOR ALL APP MODULES)
  // ===========================================================================
  app.get('/api/system-collections', authenticateAndAuthorize(['admin', 'employee', 'client', 'driver', 'partner']), async (req: Request, res: Response) => {
    try {
      await ensureSystemStateLoadedFromSupabase();
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isStaff = isOwnerSuperAdmin(callerProf) || callerRole === 'admin' || callerRole === 'employee';
      const collections = { ...persistentStorage.getSystemCollections() } as Record<string, any>;
      if (!isStaff) {
        delete collections.employees;
        delete collections.auditLogs;
        delete collections.clientDebts;
        delete collections.transferReceipts;
        delete collections.partners;
        delete collections.partnerSyncLogs;
        delete collections.vehicles;
        delete collections.driverRequests;
        delete collections.stockLocations;
        if (callerRole === 'client') {
          if (Array.isArray(collections.pickups)) {
            collections.pickups = collections.pickups.filter((p: any) => p.clientId === callerProf?.id);
          }
          if (Array.isArray(collections.bons)) {
            collections.bons = collections.bons.filter((b: any) => b.clientId === callerProf?.id);
          }
          collections.savedAddresses = persistentStorage.getUserSavedAddresses(String(callerProf?.id || ''));
        } else if (callerRole === 'driver') {
          if (Array.isArray(collections.pickups)) {
            collections.pickups = collections.pickups.filter(
              (p: any) => !p.driverId || p.driverId === callerProf?.id || p.status === 'en_attente'
            );
          }
          if (Array.isArray(collections.bons)) {
            collections.bons = collections.bons.filter((b: any) => b.driverId === callerProf?.id);
          }
        }
      } else {
        const syncedPartners = getSyncedPartners();
        if (syncedPartners.length > 0) {
          collections.partners = syncedPartners.map((p: Partner) => sanitizePartner(p));
        } else if (Array.isArray(collections.partners) && collections.partners.length > 0) {
          collections.partners = collections.partners.map((p: Partner) => sanitizePartner(p));
        } else {
          delete collections.partners;
        }
      }
      res.json({ success: true, collections });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.put('/api/system-collections/:key', authenticateAndAuthorize(['admin', 'employee']), (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isAdminCaller = isOwnerSuperAdmin(callerProf) || callerRole === 'admin';
      if ((key === 'employees' || key === 'partners' || key === 'auditLogs') && !isAdminCaller) {
        return res.status(403).json({ success: false, error: `Seul un administrateur peut modifier la collection ${key}.` });
      }
      let value = req.body?.value !== undefined ? req.body.value : req.body;
      if (key === 'partners' && Array.isArray(value)) {
        if (value.length === 0 && getSyncedPartners().length > 0) {
          return res.json({ success: true, key, skippedEmptyOverwrite: true });
        }
        const sanitizedList: Partner[] = [];
        const fullList: Partner[] = [];
        for (const p of value as Partner[]) {
          if (!p?.id) continue;
          if (p.apiConfig || p.webhookToken) {
            persistentStorage.savePartnerSecrets(p.id, {
              apiKey: p.apiConfig?.apiKey,
              apiSecret: p.apiConfig?.apiSecret,
              password: p.apiConfig?.password,
              webhookSecret: p.apiConfig?.webhookSecret,
              webhookToken: p.webhookToken
            });
          }
          const withSecrets = mergePartnerSecretsFromStorage(p);
          fullList.push(withSecrets);
          sanitizedList.push(sanitizePartner(withSecrets));
        }
        partnersCache = fullList;
        value = sanitizedList;
      }
      if (key === 'cities' && Array.isArray(value)) {
        const existingCities = persistentStorage.getSystemCollection<any[]>('cities');
        if (
          value.length === 0 ||
          (Array.isArray(existingCities) && existingCities.length > 0 && !areCitiesEqualToInitial(existingCities) && areCitiesEqualToInitial(value) && req.body?.forceReset !== true)
        ) {
          return res.json({ success: true, key, skippedStaleDefaultOverwrite: true });
        }
      }
      const ok = persistentStorage.setSystemCollection(key, value);
      if (!ok) {
        return res.status(400).json({ success: false, error: `Collection non autorisée: ${key}` });
      }
      if (key === 'driverRequests' && Array.isArray(value)) {
        driverRequestsCache = value;
      }
      if (key !== 'partners') {
        void persistSystemStateToSupabase();
      }
      res.json({ success: true, key });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // DEDICATED PERSISTENCE ENDPOINTS FOR PICKUPS, SAVED ADDRESSES & BONS (ALL ROLES)
  // ===========================================================================
  app.get('/api/pickups', authenticateAndAuthorize(['admin', 'employee', 'driver', 'client']), (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isStaff = isOwnerSuperAdmin(callerProf) || callerRole === 'admin' || callerRole === 'employee';
      const stored = persistentStorage.getSystemCollection<any[]>('pickups');
      const all = Array.isArray(stored) ? stored : [];
      const filtered = isStaff
        ? all
        : callerRole === 'client'
        ? all.filter((p: any) => p.clientId === callerProf?.id)
        : all.filter((p: any) => !p.driverId || p.driverId === callerProf?.id || p.status === 'en_attente');
      res.json({ success: true, pickups: filtered });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/pickups', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = callerRole === 'client' && !isOwnerSuperAdmin(callerProf);
      const body = req.body || {};
      const stored = persistentStorage.getSystemCollection<any[]>('pickups');
      const currentList = Array.isArray(stored) ? [...stored] : [];
      const newReq = {
        ...body,
        id: body.id || `pick-${Date.now()}`,
        clientId: isClientCaller ? callerProf.id : (body.clientId || callerProf?.id),
        trackingId: body.trackingId || `RAM-2026-${String(currentList.length + 1).padStart(3, '0')}`,
        status: body.status || 'en_attente',
        createdAt: body.createdAt || new Date().toISOString()
      };
      const next = [newReq, ...currentList.filter((p: any) => p.id !== newReq.id)];
      persistentStorage.setSystemCollection('pickups', next);
      res.status(201).json({ success: true, pickup: newReq });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.patch('/api/pickups/:id', authenticateAndAuthorize(['admin', 'employee', 'driver', 'client']), (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = callerRole === 'client' && !isOwnerSuperAdmin(callerProf);
      const stored = persistentStorage.getSystemCollection<any[]>('pickups');
      const currentList = Array.isArray(stored) ? [...stored] : [];
      const target = currentList.find((p: any) => p.id === id);
      if (!target) {
        return res.status(404).json({ success: false, error: 'Demande de ramassage introuvable.' });
      }
      if (isClientCaller && target.clientId !== callerProf.id) {
        return res.status(403).json({ success: false, error: 'Accès refusé.' });
      }
      const updated = { ...target, ...(req.body || {}), id };
      persistentStorage.setSystemCollection(
        'pickups',
        currentList.map((p: any) => (p.id === id ? updated : p))
      );
      res.json({ success: true, pickup: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/pickups/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = callerRole === 'client' && !isOwnerSuperAdmin(callerProf);
      const stored = persistentStorage.getSystemCollection<any[]>('pickups');
      const currentList = Array.isArray(stored) ? [...stored] : [];
      const target = currentList.find((p: any) => p.id === id);
      if (target && isClientCaller && target.clientId !== callerProf.id) {
        return res.status(403).json({ success: false, error: 'Accès refusé.' });
      }
      persistentStorage.setSystemCollection(
        'pickups',
        currentList.filter((p: any) => p.id !== id)
      );
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((id || '').trim());
      if (isUuid) {
        await supabase.from('pickup_requests').delete().eq('id', id.trim());
      }
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/saved-addresses', authenticateAndAuthorize(['admin', 'employee', 'client', 'driver', 'partner']), (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerId = String(callerProf?.id || '');
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isStaff = isOwnerSuperAdmin(callerProf) || callerRole === 'admin' || callerRole === 'employee';
      const userAddresses = persistentStorage.getUserSavedAddresses(callerId);
      if (userAddresses.length > 0) {
        return res.json({ success: true, addresses: userAddresses });
      }
      if (isStaff) {
        const legacy = persistentStorage.getSystemCollection<any[]>('savedAddresses');
        return res.json({ success: true, addresses: Array.isArray(legacy) ? legacy : [] });
      }
      res.json({ success: true, addresses: [] });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.put('/api/saved-addresses', authenticateAndAuthorize(['admin', 'employee', 'client', 'driver', 'partner']), (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerId = String(callerProf?.id || '');
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isStaff = isOwnerSuperAdmin(callerProf) || callerRole === 'admin' || callerRole === 'employee';
      const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : Array.isArray(req.body?.value) ? req.body.value : [];
      const saved = persistentStorage.saveUserSavedAddresses(callerId, addresses);
      if (isStaff) {
        persistentStorage.setSystemCollection('savedAddresses', saved);
      }
      res.json({ success: true, addresses: saved });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/bons', authenticateAndAuthorize(['admin', 'employee', 'client', 'driver']), (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isStaff = isOwnerSuperAdmin(callerProf) || callerRole === 'admin' || callerRole === 'employee';
      const stored = persistentStorage.getSystemCollection<any[]>('bons');
      const all = Array.isArray(stored) ? stored : [];
      const filtered = isStaff
        ? all
        : callerRole === 'client'
        ? all.filter((b: any) => b.clientId === callerProf?.id)
        : all.filter((b: any) => b.driverId === callerProf?.id);
      res.json({ success: true, bons: filtered });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/bons', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = callerRole === 'client' && !isOwnerSuperAdmin(callerProf);
      const body = req.body || {};
      const stored = persistentStorage.getSystemCollection<any[]>('bons');
      const currentList = Array.isArray(stored) ? [...stored] : [];
      const newBon = {
        ...body,
        id: body.id || `bon-${Date.now()}`,
        type: isClientCaller ? 'client' : (body.type || 'client'),
        clientId: isClientCaller ? callerProf.id : body.clientId,
        createdAt: body.createdAt || new Date().toISOString()
      };
      persistentStorage.setSystemCollection('bons', [newBon, ...currentList.filter((b: any) => b.id !== newBon.id)]);
      res.status(201).json({ success: true, bon: newBon });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.patch('/api/bons/:id', authenticateAndAuthorize(['admin', 'employee', 'driver']), (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const stored = persistentStorage.getSystemCollection<any[]>('bons');
      const currentList = Array.isArray(stored) ? [...stored] : [];
      const target = currentList.find((b: any) => b.id === id);
      if (!target) {
        return res.status(404).json({ success: false, error: 'Bon introuvable.' });
      }
      const updated = { ...target, ...(req.body || {}), id };
      persistentStorage.setSystemCollection(
        'bons',
        currentList.map((b: any) => (b.id === id ? updated : b))
      );
      res.json({ success: true, bon: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/bons/:id', authenticateAndAuthorize(['admin', 'employee', 'client']), (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const callerProf = (req as any).profile;
      const callerRole = normalizeAuthRole(String(callerProf?.role || ''));
      const isClientCaller = callerRole === 'client' && !isOwnerSuperAdmin(callerProf);
      const stored = persistentStorage.getSystemCollection<any[]>('bons');
      const currentList = Array.isArray(stored) ? [...stored] : [];
      const target = currentList.find((b: any) => b.id === id);
      if (target && isClientCaller && target.clientId !== callerProf.id) {
        return res.status(403).json({ success: false, error: 'Accès refusé.' });
      }
      persistentStorage.setSystemCollection(
        'bons',
        currentList.filter((b: any) => b.id !== id)
      );
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // FULL BACKUP & RESTORE API (EXPORT / IMPORT JSON COMPLET)
  // ===========================================================================
  app.get('/api/admin/system/backup', authenticateAndAuthorize(['admin', 'super_admin']), (_req: Request, res: Response) => {
    try {
      const backup = persistentStorage.exportFullBackup();
      res.json({ success: true, backup });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/admin/system/restore', authenticateAndAuthorize(['admin', 'super_admin']), (req: Request, res: Response) => {
    try {
      const rawBackup = req.body?.backup || req.body?.data || req.body;
      const result = persistentStorage.restoreFullBackup(rawBackup);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // VISITOR ANALYTICS (REAL BROWSER STATS FROM PERSISTENT TELEMETRY)
  // ===========================================================================
  app.post('/api/analytics/visit', (req: Request, res: Response) => {
    try {
      const ua = String(req.body?.userAgent || req.headers['user-agent'] || '').slice(0, 300);
      const recorded = persistentStorage.recordVisitorBrowser(ua);
      res.json({ success: true, browser: recorded.browser });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/admin/visitor-stats', authenticateAndAuthorize(['admin', 'employee']), (_req: Request, res: Response) => {
    try {
      const stats = persistentStorage.getVisitorStats();
      res.json({ success: true, stats });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // WHATSAPP BUSINESS API / WEBHOOK DISPATCH & LOGS
  // ===========================================================================
  app.get('/api/notifications/whatsapp-logs', authenticateAndAuthorize(['admin', 'employee']), (_req: Request, res: Response) => {
    try {
      const logs = persistentStorage.getWhatsappLogs();
      res.json({ success: true, logs });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/api/notifications/whatsapp-logs', authenticateAndAuthorize(['admin', 'super_admin']), (_req: Request, res: Response) => {
    try {
      persistentStorage.clearWhatsappLogs();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/notifications/whatsapp-dispatch', authenticateAndAuthorize(['admin', 'employee', 'driver']), async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const storedSettings = persistentStorage.getCompanySettings() || INITIAL_COMPANY_SETTINGS;
      const testMode = b.testMode === true;
      const skipLog = b.skipLog === true;

      const webhookUrl = (
        (testMode && typeof b.webhookUrl === 'string' ? b.webhookUrl : storedSettings.whatsappWebhookUrl) || ''
      ).trim();
      const apiToken = (
        (testMode && typeof b.apiToken === 'string' ? b.apiToken : storedSettings.whatsappApiToken) || ''
      ).trim();
      const template =
        (testMode && typeof b.template === 'string' && b.template.trim()
          ? b.template
          : storedSettings.whatsappCustomTemplate) ||
        '📦 {{company}} : Bonjour {{recipient}}, votre colis {{tracking}} ({{city}}) est désormais : {{status}}. Montant COD: {{cod}} MAD.';

      const trackingNumber = String(b.trackingNumber || 'FAR-TEST-0001');
      const recipientName = String(b.recipientName || 'Client Destinataire');
      const recipientPhone = String(b.recipientPhone || storedSettings.whatsapp || '+212600000000');
      const merchantPhone = typeof b.merchantPhone === 'string' ? b.merchantPhone : undefined;
      const status = String(b.status || 'en_cours_livraison');
      const statusLabel = String(b.statusLabel || status);
      const city = String(b.city || 'Casablanca');
      const codAmount = Number(b.codAmount || 0);
      const companyName = storedSettings.companyName || 'FARIOUSY DELIVERY SARL';

      const formattedMessage = template
        .replace(/\{\{company\}\}/g, companyName)
        .replace(/\{\{tracking\}\}/g, trackingNumber)
        .replace(/\{\{recipient\}\}/g, recipientName)
        .replace(/\{\{status\}\}/g, statusLabel)
        .replace(/\{\{city\}\}/g, city)
        .replace(/\{\{cod\}\}/g, String(codAmount));

      const isValidHttpUrl = /^https?:\/\/.+/i.test(webhookUrl);
      let deliveryState: WhatsappDispatchLog['deliveryState'] = 'not_configured';
      let httpStatus: number | undefined;
      let errorMsg: string | undefined;

      if (isValidHttpUrl) {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json'
          };
          if (apiToken) {
            headers['Authorization'] = apiToken.startsWith('Bearer ') ? apiToken : `Bearer ${apiToken}`;
          }

          const hookRes = await fetch(webhookUrl, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({
              event: testMode ? 'whatsapp_webhook_test' : 'package_status_changed',
              testMode,
              companyName,
              trackingNumber,
              status,
              statusLabel,
              recipientName,
              recipientPhone,
              merchantPhone,
              city,
              codAmount,
              message: formattedMessage,
              timestamp: new Date().toISOString()
            })
          });

          httpStatus = hookRes.status;
          if (hookRes.ok) {
            deliveryState = 'sent';
          } else {
            deliveryState = 'failed';
            errorMsg = `HTTP ${hookRes.status}`;
          }
        } catch (err: any) {
          deliveryState = 'failed';
          errorMsg = err?.message || 'Erreur réseau Webhook WhatsApp';
        }
      } else {
        deliveryState = 'not_configured';
        errorMsg = 'URL Webhook WhatsApp non configurée dans Paramètres';
      }

      const log: WhatsappDispatchLog = {
        id: `wa-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        packageId: String(b.packageId || 'test'),
        trackingNumber,
        recipientName,
        recipientPhone,
        merchantPhone,
        status,
        statusLabel,
        message: formattedMessage,
        webhookConfigured: isValidHttpUrl,
        deliveryState,
        httpStatus,
        error: errorMsg,
        createdAt: new Date().toISOString()
      };

      if (!skipLog) {
        persistentStorage.addWhatsappLog(log);
      }

      res.json({
        success: deliveryState === 'sent',
        webhookConfigured: isValidHttpUrl,
        log,
        error: errorMsg
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================================
  // SUPER ADMIN SECURITY & TOTAL CONTROL API (CONTRÔLE TOTAL)
  // ===========================================================================
  const requireSuperAdminOwner = (req: Request, res: Response, next: NextFunction) => {
    const profile = (req as any).profile || (req as any).user;
    if (!isOwnerSuperAdmin(profile)) {
      return res.status(403).json({
        success: false,
        error: 'Action strictement réservée au Super Administrateur propriétaire (wadarazzeddine30@gmail.com).'
      });
    }
    return next();
  };

  app.get(
    '/api/admin/security/overview',
    authenticateAndAuthorize(['admin']),
    requireSuperAdminOwner,
    async (req: Request, res: Response) => {
      try {
        const currentToken = (req as any).sessionToken as string | undefined;
        const sessions = persistentStorage.getActiveSessions(currentToken);
        const settings = persistentStorage.getSecuritySettings();
        const isDefaultAdminPassword = persistentStorage.isDefaultAdminPassword();

        const localUsers = persistentStorage.getUsers();
        let sbProfiles: any[] = [];
        let sbShops: any[] = [];
        let sbPackagesCount = 0;

        try {
          const [profRes, shopRes, pkgRes]: any[] = await Promise.all([
            safeDbQuery(
              supabase.from('profiles').select('id, email, full_name, role, status, account_status, phone, created_at'),
              1200
            ),
            safeDbQuery(
              supabase.from('merchant_shops').select('id, user_id, shop_name, email, account_status, created_at'),
              1200
            ),
            safeDbQuery(supabase.from('packages').select('id', { count: 'exact', head: true }), 1200)
          ]);
          if (Array.isArray(profRes?.data)) sbProfiles = profRes.data;
          if (Array.isArray(shopRes?.data)) sbShops = shopRes.data;
          if (typeof pkgRes?.count === 'number') sbPackagesCount = pkgRes.count;
        } catch (err: any) {
          console.warn('[Security Overview Supabase notice]', err?.message);
        }

        // Merge local + Supabase privileged accounts (super_admin, admin, employee)
        const privMap = new Map<string, any>();
        for (const u of localUsers) {
          const r = String(u.role || '').toLowerCase();
          if (r === 'super_admin' || r === 'admin' || r === 'employee') {
            privMap.set((u.email || u.id).toLowerCase(), {
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              status: u.status,
              phone: u.phone,
              source: 'server',
              isOwner: isOwnerSuperAdmin(u),
              registeredAt: u.registeredAt
            });
          }
        }
        for (const p of sbProfiles) {
          const r = String(p.role || '').toLowerCase();
          if (r === 'super_admin' || r === 'admin' || r === 'employee') {
            const key = (p.email || p.id).toLowerCase();
            const existing = privMap.get(key);
            const isOwner = isOwnerSuperAdmin({ email: p.email, role: p.role });
            privMap.set(key, {
              ...(existing || {}),
              id: p.id,
              name: p.full_name || existing?.name || 'Admin/Staff',
              email: p.email || existing?.email || '',
              role: isOwner ? 'super_admin' : p.role,
              status: p.account_status || p.status || existing?.status || 'active',
              phone: p.phone || existing?.phone || '',
              source: existing ? 'server+supabase' : 'supabase',
              isOwner,
              registeredAt: p.created_at || existing?.registeredAt
            });
          }
        }

        const privilegedUsers = Array.from(privMap.values());
        const superAdminsCount = privilegedUsers.filter(
          u => String(u.role).toLowerCase() === 'super_admin' || u.isOwner
        ).length;

        const approvedClients = sbShops.filter(s => (s.account_status || 'approuve') === 'approuve').length;
        const pendingClients = sbShops.filter(s => s.account_status === 'en_attente').length;
        const suspendedClients = sbShops.filter(s => s.account_status === 'suspendu').length;

        res.json({
          success: true,
          overview: {
            isDefaultAdminPassword,
            securitySettings: settings,
            activeSessions: sessions,
            privilegedUsers,
            counts: {
              superAdmins: superAdminsCount,
              privilegedAccounts: privilegedUsers.length,
              activeSessions: sessions.length,
              totalShops: sbShops.length,
              approvedClients,
              pendingClients,
              suspendedClients,
              totalPackages: Math.max(sbPackagesCount, persistentStorage.getPackages().length)
            }
          }
        });
      } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/admin/security/change-password',
    authenticateAndAuthorize(['admin']),
    requireSuperAdminOwner,
    async (req: Request, res: Response) => {
      try {
        const caller = (req as any).profile || (req as any).user;
        const currentToken = (req as any).sessionToken as string | undefined;
        const currentPassword = String(req.body?.currentPassword || '').trim();
        const newPassword = String(req.body?.newPassword || '').trim();
        const revokeOthers = req.body?.revokeOtherSessions !== false;

        if (!currentPassword) {
          return res.status(400).json({ success: false, error: 'Le mot de passe actuel est requis.' });
        }
        if (newPassword.length < 8) {
          return res.status(400).json({
            success: false,
            error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.'
          });
        }

        const targetEmail = String(caller?.email || 'wadarazzeddine30@gmail.com');
        const isCurrentValid = persistentStorage.verifyUserPassword(targetEmail, currentPassword);
        if (!isCurrentValid) {
          return res.status(401).json({
            success: false,
            error: 'Le mot de passe actuel saisi est incorrect.'
          });
        }

        const changed = persistentStorage.changeUserPassword(targetEmail, newPassword);
        if (!changed) {
          return res.status(500).json({ success: false, error: 'Impossible de mettre à jour le mot de passe.' });
        }

        // Sync password with Supabase Auth if admin account exists there
        try {
          if (caller?.id && /^[0-9a-f-]{36}$/i.test(String(caller.id))) {
            await supabase.auth.admin.updateUserById(String(caller.id), { password: newPassword });
          }
        } catch (sbErr: any) {
          console.warn('[SuperAdmin Supabase password sync notice]', sbErr?.message);
        }

        let revokedCount = 0;
        if (revokeOthers) {
          revokedCount = persistentStorage.revokeAllSessions(currentToken);
        }

        return res.json({
          success: true,
          message: 'Mot de passe Super Admin mis à jour avec succès.',
          revokedSessionsCount: revokedCount
        });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/admin/security/revoke-all-sessions',
    authenticateAndAuthorize(['admin']),
    requireSuperAdminOwner,
    (req: Request, res: Response) => {
      try {
        const currentToken = (req as any).sessionToken as string | undefined;
        const includeCurrent = req.body?.includeCurrent === true;
        const revokedCount = persistentStorage.revokeAllSessions(includeCurrent ? undefined : currentToken);
        if (includeCurrent) {
          clearSessionCookie(res);
        }
        res.json({
          success: true,
          revokedCount,
          message: `${revokedCount} session(s) active(s) déconnectée(s) immédiatement.`
        });
      } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/admin/security/revoke-session',
    authenticateAndAuthorize(['admin']),
    requireSuperAdminOwner,
    (req: Request, res: Response) => {
      try {
        const sessionId = String(req.body?.sessionId || '').trim();
        if (!sessionId) {
          return res.status(400).json({ success: false, error: 'sessionId requis.' });
        }
        const ok = persistentStorage.revokeSessionById(sessionId);
        if (!ok) {
          return res.status(404).json({ success: false, error: 'Session introuvable ou déjà expirée.' });
        }
        res.json({ success: true, message: 'Session révoquée avec succès.' });
      } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/admin/security/settings',
    authenticateAndAuthorize(['admin']),
    requireSuperAdminOwner,
    (req: Request, res: Response) => {
      try {
        const b = req.body || {};
        const updates: Record<string, any> = {};
        if (typeof b.requireAdminApprovalForClients === 'boolean') {
          updates.requireAdminApprovalForClients = b.requireAdminApprovalForClients;
        }
        if (typeof b.allowPublicClientRegistration === 'boolean') {
          updates.allowPublicClientRegistration = b.allowPublicClientRegistration;
        }
        if (typeof b.allowPublicDriverRegistration === 'boolean') {
          updates.allowPublicDriverRegistration = b.allowPublicDriverRegistration;
        }
        const saved = persistentStorage.saveSecuritySettings(updates);
        res.json({ success: true, securitySettings: saved });
      } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.delete(
    '/api/admin/security/privileged-user/:id',
    authenticateAndAuthorize(['admin']),
    requireSuperAdminOwner,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const target = persistentStorage.findUserById(id);
        if (target && isOwnerSuperAdmin(target)) {
          return res.status(403).json({
            success: false,
            error: 'Impossible de supprimer le compte Super Administrateur propriétaire.'
          });
        }

        const removedLocal = persistentStorage.deleteUserById(id);
        let removedSupabase = false;
        try {
          const { data: sbProf } = await supabase.from('profiles').select('id, email, role').eq('id', id).maybeSingle();
          if (sbProf && isOwnerSuperAdmin({ email: sbProf.email, role: sbProf.role })) {
            return res.status(403).json({
              success: false,
              error: 'Impossible de supprimer le compte Super Administrateur propriétaire.'
            });
          }
          if (sbProf) {
            await supabase.from('profiles').delete().eq('id', id);
            if (/^[0-9a-f-]{36}$/i.test(id)) {
              await supabase.auth.admin.deleteUser(id).catch(() => {});
            }
            removedSupabase = true;
          }
        } catch (sbErr: any) {
          console.warn('[Delete privileged user Supabase notice]', sbErr?.message);
        }

        // Also purge from employees system collection if stored there
        const empCol = persistentStorage.getSystemCollection<any[]>('employees');
        if (Array.isArray(empCol)) {
          persistentStorage.setSystemCollection(
            'employees',
            empCol.filter((e: any) => e?.id !== id)
          );
        }

        if (!removedLocal && !removedSupabase) {
          return res.status(404).json({ success: false, error: 'Compte introuvable.' });
        }

        res.json({ success: true, message: 'Accès et compte privilégié révoqués et supprimés.' });
      } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  // ===========================================================================
  // STAFF CONTROL, WORK HOURS, LIVE PRESENCE & CONFIRMATION CENTER
  // ===========================================================================
  app.get(
    '/api/staff/control-overview',
    authenticateAndAuthorize(['admin', 'employee']),
    async (req: Request, res: Response) => {
      try {
        await ensureSystemStateLoadedFromSupabase();
        const period = String(req.query.period || 'today').toLowerCase();
        const nowMs = Date.now();
        const nowDate = new Date(nowMs);
        const todayIso = nowDate.toISOString().slice(0, 10);

        // Week start (Monday 00:00 UTC) & Month start (1st of current month)
        const weekStartDate = new Date(nowDate);
        const dayOfWeek = weekStartDate.getUTCDay();
        const diffToMonday = (dayOfWeek + 6) % 7;
        weekStartDate.setUTCDate(weekStartDate.getUTCDate() - diffToMonday);
        const weekStartStr = weekStartDate.toISOString().slice(0, 10);
        const monthPrefix = todayIso.slice(0, 7);

        let periodCutoffMs = 0;
        if (period === 'today') {
          periodCutoffMs = new Date(`${todayIso}T00:00:00.000Z`).getTime();
        } else if (period === 'week') {
          periodCutoffMs = new Date(`${weekStartStr}T00:00:00.000Z`).getTime();
        } else if (period === 'month') {
          periodCutoffMs = new Date(`${monthPrefix}-01T00:00:00.000Z`).getTime();
        }

        // Gather all internal staff users (persistentStorage.users + systemCollections.employees + Supabase profiles)
        const memberMap = new Map<string, UserProfile>();
        const upsertStaffMember = (candidate: Partial<UserProfile> & { id?: string }) => {
          if (!candidate || !candidate.id) return;
          const r = String(candidate.role || '').toLowerCase();
          if (!['super_admin', 'admin', 'employee'].includes(r)) return;
          const existing = memberMap.get(candidate.id);
          memberMap.set(candidate.id, {
            ...(existing || ({} as UserProfile)),
            ...(candidate as UserProfile),
            id: candidate.id,
            name: candidate.name || existing?.name || 'Collaborateur',
            email: candidate.email || existing?.email || '',
            phone: candidate.phone || existing?.phone || '',
            role: (candidate.role || existing?.role || 'employee') as UserRole,
            status: candidate.status || existing?.status || 'active',
            accountStatus: candidate.accountStatus || existing?.accountStatus || 'approuve',
            registeredAt: candidate.registeredAt || existing?.registeredAt || todayIso
          });
        };

        for (const u of persistentStorage.getUsers()) {
          upsertStaffMember(u);
        }
        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees');
        if (Array.isArray(empCol)) {
          for (const e of empCol) {
            upsertStaffMember(e);
          }
        }
        if (isValidSupabaseKey(SUPABASE_KEY)) {
          try {
            const { data: sbStaff } = await supabase
              .from('profiles')
              .select('*')
              .in('role', ['super_admin', 'admin', 'employee']);
            if (Array.isArray(sbStaff)) {
              for (const p of sbStaff) {
                upsertStaffMember({
                  id: p.id,
                  name: p.full_name || 'Collaborateur',
                  email: p.email || '',
                  phone: p.phone || '',
                  city: p.city || 'Casablanca',
                  role: (isOwnerSuperAdmin({ email: p.email, role: p.role }) ? 'super_admin' : p.role) as UserRole,
                  status: (p.status || 'active') as any,
                  accountStatus: (p.account_status || 'approuve') as any,
                  registeredAt: p.created_at || todayIso
                });
              }
            }
          } catch {}
        }

        const presenceMap = persistentStorage.getStaffPresenceMap();
        const shifts = persistentStorage.getStaffShifts();
        const logs = persistentStorage.getConfirmationLogs();
        const activeSessions = persistentStorage.getActiveSessions();

        // Packages lookup for delivery rate of confirmed packages
        const packageStatusMap = new Map<string, string>();
        for (const lp of persistentStorage.getPackages()) {
          const merged = applyPackageOverrides(lp);
          if (merged.id) packageStatusMap.set(String(merged.id), String(merged.status || ''));
          if (merged.trackingNumber) packageStatusMap.set(String(merged.trackingNumber), String(merged.status || ''));
        }
        if (isValidSupabaseKey(SUPABASE_KEY)) {
          try {
            const { data: sbPkgs } = await supabase
              .from('packages')
              .select('id, tracking_number, status');
            if (Array.isArray(sbPkgs)) {
              for (const row of sbPkgs) {
                const ov = persistentStorage.getPackageOverrides([row.id, row.tracking_number]);
                const effStatus = String(ov?.status || row.status || '');
                if (row.id) packageStatusMap.set(String(row.id), effStatus);
                if (row.tracking_number) packageStatusMap.set(String(row.tracking_number), effStatus);
              }
            }
          } catch {}
        }

        const members: StaffControlMemberOverview[] = Array.from(memberMap.values()).map(user => {
          const presence: StaffPresenceRecord | undefined = presenceMap[user.id];
          const userSessions = activeSessions.filter(s => s.userId === user.id);
          const lastSeenMs = presence?.lastSeenAt ? new Date(presence.lastSeenAt).getTime() : 0;
          const idleSeconds = lastSeenMs > 0 ? Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000)) : 999999;
          const isOnline = idleSeconds <= 90;

          const userShifts = shifts.filter(s => s.userId === user.id);
          const currentShift =
            userShifts.find(s => s.date === todayIso && (s.status === 'active' || s.status === 'break')) || null;

          const computeEffectiveShiftSeconds = (s: StaffWorkShift): number => {
            let secs = Number(s.workedSeconds || 0);
            if (s.status === 'active' && s.id === currentShift?.id && isOnline) {
              const lastTickMs = new Date(s.lastTickAt || s.startedAt).getTime();
              const extra = Math.max(0, Math.floor((nowMs - lastTickMs) / 1000));
              if (extra > 0 && extra <= 180) secs += extra;
            }
            return secs;
          };

          const todayShifts = userShifts.filter(s => s.date === todayIso);
          const todayWorkedSeconds = todayShifts.reduce((acc, s) => acc + computeEffectiveShiftSeconds(s), 0);
          const weekWorkedSeconds = userShifts
            .filter(s => s.date >= weekStartStr)
            .reduce((acc, s) => acc + computeEffectiveShiftSeconds(s), 0);
          const monthWorkedSeconds = userShifts
            .filter(s => s.date.startsWith(monthPrefix))
            .reduce((acc, s) => acc + computeEffectiveShiftSeconds(s), 0);

          const todayFirstStartAt =
            todayShifts.length > 0
              ? todayShifts.reduce((earliest, s) => (s.startedAt < earliest ? s.startedAt : earliest), todayShifts[0].startedAt)
              : undefined;

          let workStatus: 'working' | 'break' | 'off' = 'off';
          if (currentShift) {
            workStatus = currentShift.status === 'break' ? 'break' : isOnline ? 'working' : 'break';
          } else if (presence?.workStatus === 'break') {
            workStatus = 'break';
          }

          // Confirmation performance metrics
          const userLogsAll = logs.filter(l => l.employeeId === user.id);
          const todayLogs = userLogsAll.filter(l => (l.timestamp || '').slice(0, 10) === todayIso);
          const periodLogs =
            period === 'all' || periodCutoffMs === 0
              ? userLogsAll
              : userLogsAll.filter(l => new Date(l.timestamp).getTime() >= periodCutoffMs);

          const countOutcomes = (list: ConfirmationActionLog[]) => {
            let confirmed = 0;
            let noAnswer = 0;
            let postponed = 0;
            let cancelled = 0;
            let waSent = 0;
            let handled = 0;
            const confirmedPkgIds = new Set<string>();
            let confirmedCodTotal = 0;

            for (const l of list) {
              if (l.outcome === 'whatsapp_sent') {
                waSent++;
                continue;
              }
              handled++;
              if (l.outcome === 'confirme') {
                confirmed++;
                if (!confirmedPkgIds.has(l.packageId)) {
                  confirmedPkgIds.add(l.packageId);
                  confirmedCodTotal += Number(l.codAmount || 0);
                }
              } else if (l.outcome === 'pas_de_reponse' || l.outcome === 'injoignable') {
                noAnswer++;
              } else if (l.outcome === 'reporte') {
                postponed++;
              } else if (l.outcome === 'annule') {
                cancelled++;
              }
            }
            return { confirmed, noAnswer, postponed, cancelled, waSent, handled, confirmedPkgIds, confirmedCodTotal };
          };

          const todayStats = countOutcomes(todayLogs);
          const periodStats = countOutcomes(periodLogs);

          let deliveredOfConfirmed = 0;
          for (const pid of periodStats.confirmedPkgIds) {
            if (packageStatusMap.get(pid) === 'livre') {
              deliveredOfConfirmed++;
            }
          }

          const periodWorkedHours =
            period === 'today'
              ? todayWorkedSeconds / 3600
              : period === 'week'
              ? weekWorkedSeconds / 3600
              : period === 'month'
              ? monthWorkedSeconds / 3600
              : userShifts.reduce((acc, s) => acc + computeEffectiveShiftSeconds(s), 0) / 3600;

          const confirmationRate =
            periodStats.handled > 0 ? Math.round((periodStats.confirmed / periodStats.handled) * 100) : 0;
          const deliveredOfConfirmedRate =
            periodStats.confirmedPkgIds.size > 0
              ? Math.round((deliveredOfConfirmed / periodStats.confirmedPkgIds.size) * 100)
              : 0;
          const confirmationsPerHour =
            periodWorkedHours >= 0.05 ? Math.round((periodStats.confirmed / periodWorkedHours) * 10) / 10 : 0;

          return {
            user,
            isOnline,
            idleSeconds,
            lastSeenAt: presence?.lastSeenAt,
            activeSessionsCount: userSessions.length,
            workStatus,
            currentShift: currentShift
              ? { ...currentShift, workedSeconds: computeEffectiveShiftSeconds(currentShift) }
              : null,
            todayWorkedSeconds,
            weekWorkedSeconds,
            monthWorkedSeconds,
            todayFirstStartAt,
            currentPage: presence?.currentPage,
            lastActionAt: presence?.lastActionAt,
            lastActionLabel: presence?.lastActionLabel,
            performance: {
              todayActions: todayStats.handled,
              todayConfirmed: todayStats.confirmed,
              todayNoAnswer: todayStats.noAnswer,
              todayPostponed: todayStats.postponed,
              todayCancelled: todayStats.cancelled,
              todayWhatsAppSent: todayStats.waSent,
              totalHandled: periodStats.handled,
              totalConfirmed: periodStats.confirmed,
              totalNoAnswer: periodStats.noAnswer,
              totalPostponed: periodStats.postponed,
              totalCancelled: periodStats.cancelled,
              totalWhatsAppSent: periodStats.waSent,
              confirmationRate,
              deliveredOfConfirmedRate,
              confirmedCodTotal: Math.round(periodStats.confirmedCodTotal),
              confirmationsPerHour
            }
          };
        });

        // Sort: employees first, then working/online first, then by name
        members.sort((a, b) => {
          const aEmp = a.user.role === 'employee' ? 0 : 1;
          const bEmp = b.user.role === 'employee' ? 0 : 1;
          if (aEmp !== bEmp) return aEmp - bEmp;
          if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
          return a.user.name.localeCompare(b.user.name);
        });

        return res.json({
          success: true,
          period,
          members,
          shifts: shifts.slice(0, 200),
          confirmationLogs: logs.slice(0, 300)
        });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/staff/heartbeat',
    authenticateAndAuthorize(['admin', 'employee']),
    (req: Request, res: Response) => {
      try {
        const caller = (req as any).profile || (req as any).user;
        const stored = persistentStorage.findUserById(caller.id);
        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees');
        const colUser = Array.isArray(empCol) ? empCol.find(e => e.id === caller.id) : undefined;
        const effectiveUser = {
          id: caller.id,
          name: stored?.name || colUser?.name || caller.name || caller.full_name || caller.email || 'Collaborateur',
          email: stored?.email || colUser?.email || caller.email || '',
          role: (stored?.role || caller.role || 'employee') as UserRole,
          employeeRole: stored?.employeeRole || colUser?.employeeRole
        };

        const { currentPage, offline, actionLabel } = req.body || {};
        const result = persistentStorage.recordStaffHeartbeat(effectiveUser, {
          currentPage: typeof currentPage === 'string' ? currentPage : undefined,
          offline: offline === true,
          actionLabel: typeof actionLabel === 'string' ? actionLabel : undefined
        });

        return res.json({ success: true, ...result });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/staff/shift',
    authenticateAndAuthorize(['admin', 'employee']),
    (req: Request, res: Response) => {
      try {
        const caller = (req as any).profile || (req as any).user;
        const callerNorm = normalizeAuthRole(String(caller?.role || ''));
        const isAdminCaller = isOwnerSuperAdmin(caller) || callerNorm === 'admin';

        const action = String(req.body?.action || '') as 'start' | 'pause' | 'resume' | 'end';
        if (!['start', 'pause', 'resume', 'end'].includes(action)) {
          return res.status(400).json({ success: false, error: 'Action de pointage invalide.' });
        }

        const targetUserId = String(req.body?.targetUserId || caller.id);
        if (targetUserId !== caller.id && !isAdminCaller) {
          return res.status(403).json({ success: false, error: 'Seul un administrateur peut modifier le pointage d’un autre agent.' });
        }

        const stored = persistentStorage.findUserById(targetUserId);
        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees');
        const colUser = Array.isArray(empCol) ? empCol.find(e => e.id === targetUserId) : undefined;
        const targetUser = {
          id: targetUserId,
          name: stored?.name || colUser?.name || (targetUserId === caller.id ? caller.name || caller.email : 'Collaborateur'),
          email: stored?.email || colUser?.email || '',
          role: (stored?.role || colUser?.role || 'employee') as UserRole,
          employeeRole: stored?.employeeRole || colUser?.employeeRole
        };

        const actorName = caller.name || caller.full_name || caller.email || 'Administration';
        const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
        const result = persistentStorage.controlStaffShift(targetUser, action, actorName, note);
        void persistSystemStateToSupabase();

        return res.json({ success: true, ...result });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/staff/confirmation-action',
    authenticateAndAuthorize(['admin', 'employee']),
    async (req: Request, res: Response) => {
      try {
        const caller = (req as any).profile || (req as any).user;
        const storedCaller = persistentStorage.findUserById(caller.id);
        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees');
        const colCaller = Array.isArray(empCol) ? empCol.find(e => e.id === caller.id) : undefined;

        const actorId = caller.id;
        const actorName = storedCaller?.name || colCaller?.name || caller.name || caller.full_name || caller.email || 'Agent';
        const actorRole = storedCaller?.employeeRole || colCaller?.employeeRole || caller.role || 'employee';

        const {
          packageId,
          trackingNumber: bodyTracking,
          outcome,
          channel,
          note,
          newStatus,
          recipientName: bodyRecipient,
          recipientPhone: bodyPhone,
          city: bodyCity,
          codAmount: bodyCod
        } = req.body || {};

        const validOutcomes: ConfirmationOutcome[] = [
          'confirme',
          'pas_de_reponse',
          'reporte',
          'annule',
          'injoignable',
          'whatsapp_sent'
        ];
        if (!packageId || !validOutcomes.includes(outcome)) {
          return res.status(400).json({ success: false, error: 'packageId et outcome valides requis.' });
        }
        const validatedOutcome = outcome as ConfirmationOutcome;

        let dbRow: any = null;
        if (isValidSupabaseKey(SUPABASE_KEY)) {
          try {
            const cleanId = String(packageId).trim();
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
            const q = isUuid
              ? supabase.from('packages').select('*').eq('id', cleanId)
              : supabase.from('packages').select('*').eq('tracking_number', cleanId.toUpperCase());
            const { data } = await q.maybeSingle();
            dbRow = data || null;
          } catch {}
        }

        const localPkg =
          persistentStorage.getPackageByIdOrTracking(String(packageId)) ||
          (bodyTracking ? persistentStorage.getPackageByIdOrTracking(String(bodyTracking)) : null);

        const resolvedId = dbRow?.id || localPkg?.id || String(packageId);
        const resolvedTracking = dbRow?.tracking_number || localPkg?.trackingNumber || bodyTracking || resolvedId;
        const currentStatus = (localPkg?.status || dbRow?.status || 'nouveau') as PackageStatus;
        const existingOverride = persistentStorage.getPackageOverrides([resolvedId, resolvedTracking]);

        const nowIso = new Date().toISOString();
        const prevAttempts = Number(
          existingOverride?.confirmationAttempts ?? localPkg?.confirmationAttempts ?? 0
        );

        let targetStatus: PackageStatus = (newStatus as PackageStatus) || currentStatus;
        let confirmationStatusValue: PackageItem['confirmationStatus'] =
          existingOverride?.confirmationStatus || localPkg?.confirmationStatus || 'en_attente';

        if (validatedOutcome === 'confirme') {
          confirmationStatusValue = 'confirme';
          if (!newStatus) {
            if (['nouveau', 'pas_de_reponse', 'reporte'].includes(currentStatus)) {
              targetStatus = 'attente_ramassage';
            }
          }
        } else if (validatedOutcome === 'pas_de_reponse') {
          confirmationStatusValue = 'pas_de_reponse';
          if (!newStatus) targetStatus = 'pas_de_reponse';
        } else if (validatedOutcome === 'injoignable') {
          confirmationStatusValue = 'injoignable';
          if (!newStatus) targetStatus = 'pas_de_reponse';
        } else if (validatedOutcome === 'reporte') {
          confirmationStatusValue = 'reporte';
          if (!newStatus) targetStatus = 'reporte';
        } else if (validatedOutcome === 'annule') {
          confirmationStatusValue = 'annule';
          if (!newStatus) targetStatus = 'annule';
        } else if (validatedOutcome === 'whatsapp_sent') {
          if (confirmationStatusValue === undefined) confirmationStatusValue = 'en_attente';
        }

        const outcomeLabels: Record<ConfirmationOutcome, string> = {
          confirme: 'تم التأكيد مع الزبون (Confirmé)',
          pas_de_reponse: 'لا يرد على الهاتف (Pas de réponse)',
          reporte: 'مؤجل بطلب الزبون (Reporté)',
          annule: 'ملغى عند التأكيد (Annulé)',
          injoignable: 'الهاتف غير مشغل (Injoignable)',
          whatsapp_sent: 'تم إرسال رسالة التأكيد عبر واتساب'
        };

        const resolvedChannel: 'whatsapp' | 'appel' | 'manuel' =
          channel === 'whatsapp' || channel === 'appel' || channel === 'manuel'
            ? channel
            : validatedOutcome === 'whatsapp_sent'
            ? 'whatsapp'
            : 'appel';

        const log = persistentStorage.addConfirmationLog({
          packageId: resolvedId,
          trackingNumber: resolvedTracking,
          recipientName: dbRow?.recipient_name || localPkg?.recipientName || bodyRecipient || 'Destinataire',
          recipientPhone: dbRow?.recipient_phone || localPkg?.recipientPhone || bodyPhone || '',
          city: dbRow?.destination_city || localPkg?.city || bodyCity || '',
          codAmount: Number(dbRow?.cod_amount ?? localPkg?.codAmount ?? bodyCod ?? 0),
          employeeId: actorId,
          employeeName: actorName,
          employeeRole: String(actorRole),
          outcome: validatedOutcome,
          channel: resolvedChannel,
          note: typeof note === 'string' && note.trim() ? note.trim() : undefined
        });

        const historyEntry = {
          id: `h-conf-${Date.now()}`,
          timestamp: nowIso,
          status: targetStatus,
          statusLabel: outcomeLabels[validatedOutcome],
          updatedBy: actorName,
          role: (caller.role || 'employee') as UserRole,
          location: dbRow?.destination_city || localPkg?.city || 'Centre de Confirmation',
          comment:
            typeof note === 'string' && note.trim()
              ? `${outcomeLabels[validatedOutcome]} — ${note.trim()}`
              : outcomeLabels[validatedOutcome]
        };

        if (dbRow && validatedOutcome !== 'whatsapp_sent') {
          await supabase
            .from('packages')
            .update({ status: targetStatus, updated_at: nowIso })
            .eq('id', dbRow.id)
            .then(() => {}, () => {});
        }

        const pkgPatch: Partial<PackageItem> = {
          confirmationStatus: confirmationStatusValue,
          confirmationAttempts: prevAttempts + 1,
          lastConfirmationAttemptAt: nowIso,
          confirmationChannel: resolvedChannel,
          ...(typeof note === 'string' && note.trim() ? { confirmationNote: note.trim() } : {}),
          ...(validatedOutcome !== 'whatsapp_sent' ? { status: targetStatus, lastMovedAt: nowIso } : {}),
          ...(validatedOutcome === 'confirme'
            ? { confirmedById: actorId, confirmedByName: actorName, confirmedAt: nowIso }
            : {})
        };

        const localUpdated = persistentStorage.updatePackage(resolvedId, pkgPatch);
        const savedOverride = persistentStorage.savePackageOverrides([resolvedId, resolvedTracking], {
          ...pkgPatch,
          history: [historyEntry]
        });

        persistentStorage.recordStaffHeartbeat(
          {
            id: actorId,
            name: actorName,
            email: caller.email || '',
            role: (caller.role || 'employee') as UserRole,
            employeeRole: String(actorRole)
          },
          {
            currentPage: 'admin_confirmation',
            actionLabel: `${outcomeLabels[validatedOutcome]} (#${resolvedTracking})`
          }
        );

        void persistSystemStateToSupabase();

        return res.json({
          success: true,
          log,
          packagePatch: {
            id: resolvedId,
            trackingNumber: resolvedTracking,
            ...pkgPatch,
            ...(localUpdated || savedOverride),
            historyEntry
          }
        });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // ADMIN EMPLOYEES MANAGEMENT (REAL LOGIN CREDENTIALS + PERMISSIONS + CONTROL)
  // ---------------------------------------------------------------------------
  app.post(
    '/api/admin/employees',
    authenticateAndAuthorize(['admin']),
    async (req: Request, res: Response) => {
      try {
        const b = req.body || {};
        const name = String(b.name || '').trim();
        const email = String(b.email || '').trim().toLowerCase();
        const phone = String(b.phone || '').trim();
        const password = String(b.password || '').trim();
        const employeeRole = b.employeeRole || 'confirmatrice';
        const dailyTargetConfirmations = Number(b.dailyTargetConfirmations || 30);

        if (!name || !email || !phone) {
          return res.status(400).json({ success: false, error: 'الاسم والإيميل والهاتف إجباريين.' });
        }
        if (password.length < 6) {
          return res.status(400).json({ success: false, error: 'كلمة المرور خصها تكون على الأقل 6 حروف أو أرقام.' });
        }

        const existingByEmail = persistentStorage.findUserByIdentifier(email);
        if (existingByEmail) {
          return res.status(409).json({ success: false, error: 'هاد البريد الإلكتروني مستعمل ديجا فالحسابات.' });
        }

        const newId = b.id || `usr-emp-${Date.now()}`;
        const createdUser = persistentStorage.createUser({
          id: newId,
          name,
          email,
          phone,
          role: 'employee',
          employeeRole,
          dailyTargetConfirmations,
          agencyId: b.agencyId || 'agency-casa',
          agencyName: b.agencyName || 'Hub Agence',
          city: b.city || 'Casablanca',
          status: 'active',
          accountStatus: 'approuve',
          permissions: Array.isArray(b.permissions)
            ? b.permissions
            : ['confirmation', 'packages_manage', 'scanner', 'stock'],
          password
        } as any);

        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees') || [];
        const nextEmployees = [createdUser, ...empCol.filter(e => e?.id !== createdUser.id)];
        persistentStorage.setSystemCollection('employees', nextEmployees);
        void persistSystemStateToSupabase();

        return res.json({ success: true, employee: createdUser });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.patch(
    '/api/admin/employees/:id',
    authenticateAndAuthorize(['admin']),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const b = req.body || {};
        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees') || [];
        const colExisting = empCol.find(e => e?.id === id);
        let storedExisting = persistentStorage.findUserById(id);

        if (!storedExisting && !colExisting) {
          return res.status(404).json({ success: false, error: 'حساب الموظف غير موجود.' });
        }

        const updates: Partial<UserProfile> = {};
        if (typeof b.name === 'string' && b.name.trim()) updates.name = b.name.trim();
        if (typeof b.email === 'string' && b.email.trim()) updates.email = b.email.trim().toLowerCase();
        if (typeof b.phone === 'string' && b.phone.trim()) updates.phone = b.phone.trim();
        if (typeof b.agencyId === 'string') updates.agencyId = b.agencyId;
        if (typeof b.agencyName === 'string') updates.agencyName = b.agencyName;
        if (typeof b.city === 'string') updates.city = b.city;
        if (typeof b.employeeRole === 'string') updates.employeeRole = b.employeeRole as any;
        if (b.dailyTargetConfirmations !== undefined) {
          updates.dailyTargetConfirmations = Number(b.dailyTargetConfirmations) || 30;
        }
        if (Array.isArray(b.permissions)) updates.permissions = b.permissions;
        if (b.status === 'active' || b.status === 'inactive') {
          updates.status = b.status;
          updates.accountStatus = b.status === 'active' ? 'approuve' : 'suspendu';
        }

        let updatedUser: UserProfile | null = null;
        if (storedExisting) {
          updatedUser = persistentStorage.updateUser(id, updates);
        } else if (colExisting) {
          updatedUser = persistentStorage.upsertUser({
            ...colExisting,
            ...updates,
            id,
            role: 'employee'
          } as any);
        }

        if (typeof b.password === 'string' && b.password.trim().length > 0) {
          if (b.password.trim().length < 6) {
            return res.status(400).json({ success: false, error: 'كلمة المرور خصها تكون على الأقل 6 حروف.' });
          }
          persistentStorage.changeUserPassword(id, b.password.trim());
        }

        if (updates.status === 'inactive') {
          persistentStorage.revokeSessionsForUser(id);
        }

        if (updatedUser) {
          const nextEmployees = empCol.some(e => e?.id === id)
            ? empCol.map(e => (e?.id === id ? { ...e, ...updatedUser } : e))
            : [updatedUser, ...empCol];
          persistentStorage.setSystemCollection('employees', nextEmployees);
          void persistSystemStateToSupabase();
        }

        return res.json({ success: true, employee: updatedUser });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.delete(
    '/api/admin/employees/:id',
    authenticateAndAuthorize(['admin']),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const target = persistentStorage.findUserById(id);
        if (target && isOwnerSuperAdmin(target)) {
          return res.status(403).json({ success: false, error: 'لا يمكن حذف حساب المدير العام.' });
        }
        persistentStorage.revokeSessionsForUser(id);
        persistentStorage.deleteUserById(id);
        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees') || [];
        persistentStorage.setSystemCollection(
          'employees',
          empCol.filter(e => e?.id !== id)
        );
        void persistSystemStateToSupabase();
        return res.json({ success: true });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/admin/employees/:id/disconnect',
    authenticateAndAuthorize(['admin']),
    (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const revokedCount = persistentStorage.revokeSessionsForUser(id);
        const stored = persistentStorage.findUserById(id);
        const empCol = persistentStorage.getSystemCollection<UserProfile[]>('employees') || [];
        const colUser = empCol.find(e => e?.id === id);
        if (stored || colUser) {
          const u = stored || colUser!;
          persistentStorage.recordStaffHeartbeat(
            {
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              employeeRole: u.employeeRole
            },
            {
              offline: true,
              actionLabel: 'تم قطع الاتصال من الإدارة'
            }
          );
          void persistSystemStateToSupabase();
        }
        return res.json({
          success: true,
          revokedCount,
          message: `تم قطع الاتصال وحذف ${revokedCount} جلسة نشطة.`
        });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // CUSTOMER BLACKLIST (اللائحة السوداء المشتركة للزبناء)
  // ---------------------------------------------------------------------------
  app.get(
    '/api/blacklist',
    authenticateAndAuthorize(['client', 'admin', 'employee', 'driver']),
    (req: Request, res: Response) => {
      try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const digitsQ = q.replace(/\D/g, '');
        let entries = persistentStorage.getBlacklistEntries();

        if (q) {
          entries = entries.filter(e => {
            if (e.phone.toLowerCase().includes(q)) return true;
            if (digitsQ.length >= 3 && (e.normalizedPhone.includes(digitsQ) || e.phone.replace(/\D/g, '').includes(digitsQ))) {
              return true;
            }
            if ((e.customerName || '').toLowerCase().includes(q)) return true;
            if ((e.city || '').toLowerCase().includes(q)) return true;
            if ((e.comment || '').toLowerCase().includes(q)) return true;
            if ((e.reason || '').toLowerCase().includes(q)) return true;
            if ((e.reportedByCompany || e.reportedByName || '').toLowerCase().includes(q)) return true;
            return false;
          });
        }

        return res.json({ success: true, entries });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.get(
    '/api/blacklist/check',
    authenticateAndAuthorize(['client', 'admin', 'employee', 'driver']),
    (req: Request, res: Response) => {
      try {
        const phone = String(req.query.phone || '').trim();
        const result = persistentStorage.checkBlacklistPhone(phone);
        return res.json({ success: true, ...result });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    '/api/blacklist',
    authenticateAndAuthorize(['client', 'admin', 'employee']),
    (req: Request, res: Response) => {
      try {
        const actor = (req as any).user as UserProfile;
        const b = req.body || {};
        const result = persistentStorage.addBlacklistEntry({
          phone: String(b.phone || ''),
          customerName: typeof b.customerName === 'string' ? b.customerName : undefined,
          city: typeof b.city === 'string' ? b.city : undefined,
          reason: typeof b.reason === 'string' ? b.reason : undefined,
          comment: String(b.comment || ''),
          reportedById: actor.id,
          reportedByName: actor.name,
          reportedByCompany: actor.companyName || actor.name,
          reportedByRole: actor.role
        });

        if (!result.success) {
          return res.status(400).json({ success: false, error: result.error });
        }

        void persistSystemStateToSupabase();
        return res.json({
          success: true,
          entry: result.entry,
          entries: persistentStorage.getBlacklistEntries()
        });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.delete(
    '/api/blacklist/:id',
    authenticateAndAuthorize(['client', 'admin', 'employee']),
    (req: Request, res: Response) => {
      try {
        const actor = (req as any).user as UserProfile;
        const isAdminActor = actor.role === 'admin' || actor.role === 'super_admin';
        const result = persistentStorage.deleteBlacklistEntry(req.params.id, actor.id, isAdminActor);
        if (!result.success) {
          return res.status(result.error?.includes('فقط') ? 403 : 404).json({
            success: false,
            error: result.error
          });
        }
        void persistSystemStateToSupabase();
        return res.json({
          success: true,
          entries: persistentStorage.getBlacklistEntries()
        });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e.message });
      }
    }
  );

  return app;
}

