import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  BlacklistEntry,
  ClientStockInvoice,
  ClientStockInvoiceItem,
  ClientStockMovement,
  ClientStockProduct,
  ClientStockUnit,
  CompanySettings,
  ConfirmationActionLog,
  CustomerReview,
  PackageItem,
  PackageProblemReport,
  SavedAddress,
  StaffPresenceRecord,
  StaffWorkShift,
  UserProfile,
  UserRole,
  WhatsappDispatchLog
} from '../types';
import { normalizeBlacklistPhone } from '../utils/blacklist';

export interface StoredUser extends UserProfile {
  passwordHash?: string;
}

export interface StoredShop {
  id: string;
  user_id: string;
  shop_name: string;
  manager_name: string;
  phone: string;
  whatsapp?: string;
  email: string;
  city: string;
  pickup_address: string;
  activity_type?: string;
  account_status: 'en_attente' | 'approuve' | 'refuse' | 'suspendu';
  status_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface KycDocumentRecord {
  cinNumber?: string;
  cinPhotoUrl?: string;
  cinBackPhotoUrl?: string;
  driverPhotoUrl?: string;
  bankName?: string;
  bankRib?: string;
  updatedAt: string;
}

export interface PackageOptionsRecord {
  allowOpen?: boolean;
  allowTry?: boolean;
  isFragile?: boolean;
  isExchange?: boolean;
  exchangeTrackingNumber?: string;
  exchangeReason?: string;
  exchangeItemDescription?: string;
  updatedAt?: string;
}

export interface SecuritySettings {
  requireAdminApprovalForClients: boolean;
  allowPublicClientRegistration: boolean;
  allowPublicDriverRegistration: boolean;
  adminPasswordChanged?: boolean;
  updatedAt?: string;
}

export interface SessionRecord {
  user: UserProfile;
  expiresAt: number;
  createdAt?: string;
  ip?: string;
  userAgent?: string;
}

export interface DriverMetaRecord {
  driverFeePerDelivery?: number;
  driverFixedSalary?: number;
  driverSalaryType?: 'per_package' | 'fixed_plus_package' | 'monthly_fixed';
  driverPickupFee?: number;
  driverBonusThreshold?: number;
  driverBonusAmount?: number;
  address?: string;
  whatsapp?: string;
  driverVehicle?: string;
  driverPlate?: string;
  updatedAt?: string;
}

export interface PartnerSecretRecord {
  apiKey?: string;
  apiSecret?: string;
  password?: string;
  webhookSecret?: string;
  webhookToken?: string;
  updatedAt?: string;
}

export interface VisitorStatsRecord {
  chrome: number;
  safari: number;
  firefox: number;
  edge: number;
  other: number;
  updatedAt?: string;
}

interface StorageSchema {
  users: StoredUser[];
  shops: StoredShop[];
  packages: PackageItem[];
  auditLogs: any[];
  problemReports?: Record<string, PackageProblemReport>;
  packageOptions?: Record<string, PackageOptionsRecord>;
  packageOverrides?: Record<string, Partial<PackageItem>>;
  kycDocuments?: Record<string, KycDocumentRecord>;
  driverMeta?: Record<string, DriverMetaRecord>;
  partnerSecrets?: Record<string, PartnerSecretRecord>;
  userSavedAddresses?: Record<string, SavedAddress[]>;
  companySettings?: CompanySettings;
  securitySettings?: SecuritySettings;
  reviews?: CustomerReview[];
  clientStockProducts?: ClientStockProduct[];
  clientStockMovements?: ClientStockMovement[];
  clientStockInvoices?: ClientStockInvoice[];
  systemCollections?: Record<string, any>;
  whatsappLogs?: WhatsappDispatchLog[];
  visitorStats?: VisitorStatsRecord;
  sessions?: Record<string, SessionRecord>;
}

const STORAGE_FILE_PATH = path.resolve(process.cwd(), 'data', 'fariousy_storage.json');

const INITIAL_ADMIN: StoredUser = {
  id: 'usr-admin-wadar',
  name: 'Azzeddine Wadar',
  email: 'wadarazzeddine30@gmail.com',
  phone: '+212 661 00 00 01',
  role: 'super_admin',
  companyName: 'FARIOUSY DELIVERY SARL',
  city: 'Laâyoune',
  address: 'Siège Social - Laâyoune / Casablanca',
  status: 'active',
  accountStatus: 'approuve',
  registeredAt: '2025-01-01T00:00:00.000Z',
  passwordHash: 'admin123'
};

class PersistentStorageService {
  private data: StorageSchema = {
    users: [],
    shops: [],
    packages: [],
    auditLogs: [],
    problemReports: {},
    packageOptions: {},
    packageOverrides: {},
    kycDocuments: {},
    driverMeta: {},
    partnerSecrets: {},
    userSavedAddresses: {},
    reviews: [],
    clientStockProducts: [],
    clientStockMovements: [],
    clientStockInvoices: [],
    systemCollections: {},
    whatsappLogs: [],
    visitorStats: { chrome: 0, safari: 0, firefox: 0, edge: 0, other: 0 },
    sessions: {}
  };

  private sessions: Map<string, SessionRecord> = new Map();

  private hashPassword(plain: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
  }

  private verifyPassword(plain: string, stored?: string): boolean {
    if (!plain || !stored) return false;
    if (stored.startsWith('scrypt$')) {
      const parts = stored.split('$');
      if (parts.length !== 3) return false;
      const [, salt, hashHex] = parts;
      try {
        const derivedBuf = crypto.scryptSync(plain, salt, 64);
        const storedBuf = Buffer.from(hashHex, 'hex');
        if (derivedBuf.length !== storedBuf.length) return false;
        return crypto.timingSafeEqual(derivedBuf, storedBuf);
      } catch {
        return false;
      }
    }
    // Exact constant-time comparison for legacy unhashed passwords
    const a = Buffer.from(plain, 'utf8');
    const b = Buffer.from(stored, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  constructor() {
    this.init();
  }

  private init() {
    try {
      const dir = path.dirname(STORAGE_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(STORAGE_FILE_PATH)) {
        const raw = fs.readFileSync(STORAGE_FILE_PATH, 'utf-8');
        this.data = JSON.parse(raw);
      } else {
        this.data = {
          users: [INITIAL_ADMIN],
          shops: [],
          packages: [],
          auditLogs: [],
          sessions: {}
        };
        this.persist();
      }

      // Restore active persisted sessions across server restarts
      if (this.data.sessions && typeof this.data.sessions === 'object') {
        const now = Date.now();
        let pruned = false;
        for (const [tok, sess] of Object.entries(this.data.sessions)) {
          if (sess && sess.user && sess.expiresAt > now) {
            this.sessions.set(tok, sess);
          } else {
            delete this.data.sessions[tok];
            pruned = true;
          }
        }
        if (pruned) {
          this.persist();
        }
      } else {
        this.data.sessions = {};
      }

      // Ensure super_admin exists and has full permissions
      const existingAdminIndex = this.data.users.findIndex(
        u => u.email.toLowerCase() === INITIAL_ADMIN.email.toLowerCase() || u.role === 'admin' || u.role === 'super_admin'
      );
      if (existingAdminIndex === -1) {
        this.data.users.unshift(INITIAL_ADMIN);
        this.persist();
      } else {
        this.data.users[existingAdminIndex].role = 'super_admin';
        this.data.users[existingAdminIndex].status = 'active';
        this.data.users[existingAdminIndex].accountStatus = 'approuve';
        this.persist();
      }
    } catch (err) {
      console.warn('[PersistentStorageService init warning]', err);
      this.data = {
        users: [INITIAL_ADMIN],
        shops: [],
        packages: [],
        auditLogs: [],
        sessions: {}
      };
    }
  }

  private persist() {
    try {
      fs.writeFileSync(STORAGE_FILE_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[PersistentStorageService persist error]', err);
    }
  }

  // ---------------------------------------------------------------------------
  // USERS & AUTH
  // ---------------------------------------------------------------------------
  public getUsers(): UserProfile[] {
    return this.data.users.map(({ passwordHash, ...rest }) => {
      const kyc = this.getKycDocuments([rest.id, rest.email]);
      const dMeta = rest.role === 'driver' ? this.getDriverMeta([rest.id, rest.email]) : null;
      return {
        ...rest,
        ...(dMeta
          ? {
              address: rest.address || dMeta.address || '',
              whatsapp: rest.whatsapp || dMeta.whatsapp,
              driverVehicle: rest.driverVehicle || dMeta.driverVehicle,
              driverPlate: rest.driverPlate || dMeta.driverPlate,
              driverFeePerDelivery: dMeta.driverFeePerDelivery ?? rest.driverFeePerDelivery,
              driverFixedSalary: dMeta.driverFixedSalary ?? rest.driverFixedSalary,
              driverSalaryType: dMeta.driverSalaryType ?? rest.driverSalaryType,
              driverPickupFee: dMeta.driverPickupFee ?? rest.driverPickupFee,
              driverBonusThreshold: dMeta.driverBonusThreshold ?? rest.driverBonusThreshold,
              driverBonusAmount: dMeta.driverBonusAmount ?? rest.driverBonusAmount
            }
          : {}),
        cinNumber: rest.cinNumber || kyc?.cinNumber,
        cinPhotoUrl: rest.cinPhotoUrl || kyc?.cinPhotoUrl,
        cinBackPhotoUrl: rest.cinBackPhotoUrl || kyc?.cinBackPhotoUrl,
        driverPhotoUrl: rest.driverPhotoUrl || kyc?.driverPhotoUrl,
        avatarUrl: rest.avatarUrl || rest.driverPhotoUrl || kyc?.driverPhotoUrl,
        bankName: rest.bankName ?? kyc?.bankName,
        bankRib: rest.bankRib ?? kyc?.bankRib
      } as UserProfile;
    });
  }

  public findUserById(id: string): UserProfile | null {
    const user = this.data.users.find(u => u.id === id);
    if (!user) return null;
    const { passwordHash, ...rest } = user;
    const kyc = this.getKycDocuments([rest.id, rest.email]);
    const dMeta = rest.role === 'driver' ? this.getDriverMeta([rest.id, rest.email]) : null;
    return {
      ...rest,
      ...(dMeta
        ? {
            address: rest.address || dMeta.address || '',
            whatsapp: rest.whatsapp || dMeta.whatsapp,
            driverVehicle: rest.driverVehicle || dMeta.driverVehicle,
            driverPlate: rest.driverPlate || dMeta.driverPlate,
            driverFeePerDelivery: dMeta.driverFeePerDelivery ?? rest.driverFeePerDelivery,
            driverFixedSalary: dMeta.driverFixedSalary ?? rest.driverFixedSalary,
            driverSalaryType: dMeta.driverSalaryType ?? rest.driverSalaryType,
            driverPickupFee: dMeta.driverPickupFee ?? rest.driverPickupFee,
            driverBonusThreshold: dMeta.driverBonusThreshold ?? rest.driverBonusThreshold,
            driverBonusAmount: dMeta.driverBonusAmount ?? rest.driverBonusAmount
          }
        : {}),
      cinNumber: rest.cinNumber || kyc?.cinNumber,
      cinPhotoUrl: rest.cinPhotoUrl || kyc?.cinPhotoUrl,
      cinBackPhotoUrl: rest.cinBackPhotoUrl || kyc?.cinBackPhotoUrl,
      driverPhotoUrl: rest.driverPhotoUrl || kyc?.driverPhotoUrl,
      avatarUrl: rest.avatarUrl || rest.driverPhotoUrl || kyc?.driverPhotoUrl,
      bankName: rest.bankName ?? kyc?.bankName,
      bankRib: rest.bankRib ?? kyc?.bankRib
    } as UserProfile;
  }

  public findUserByIdentifier(identifier: string): StoredUser | null {
    const clean = (identifier || '').trim().toLowerCase();
    const cleanDigits = clean.replace(/\D/g, '');

    return (
      this.data.users.find(u => {
        const emailMatch = (u.email || '').toLowerCase() === clean;
        const uPhoneDigits = (u.phone || '').replace(/\D/g, '');
        const uWhatsappDigits = (u.whatsapp || '').replace(/\D/g, '');
        const phoneMatch =
          cleanDigits.length >= 8 &&
          (uPhoneDigits.endsWith(cleanDigits.slice(-8)) || uWhatsappDigits.endsWith(cleanDigits.slice(-8)));

        return emailMatch || phoneMatch;
      }) || null
    );
  }

  public verifyCredentials(identifier: string, password?: string): UserProfile | null {
    const cleanId = (identifier || '').trim().toLowerCase();
    const cleanPass = (password || '').trim();
    if (!cleanId || !cleanPass) return null;

    // Special check for primary admin wadarazzeddine30@gmail.com (strict password check!)
    if (cleanId === 'wadarazzeddine30@gmail.com' || cleanId === '0661000001' || cleanId === '+212661000001') {
      let admin = this.data.users.find(u => u.email.toLowerCase() === 'wadarazzeddine30@gmail.com');
      if (!admin) {
        admin = { ...INITIAL_ADMIN };
        this.data.users.unshift(admin);
        this.persist();
      }
      if (this.verifyPassword(cleanPass, admin.passwordHash || INITIAL_ADMIN.passwordHash)) {
        const { passwordHash, ...safe } = admin;
        return safe as UserProfile;
      }
      return null;
    }

    const user = this.findUserByIdentifier(cleanId);
    if (!user || !user.passwordHash) return null;

    if (this.verifyPassword(cleanPass, user.passwordHash)) {
      const { passwordHash, ...safe } = user;
      return safe as UserProfile;
    }

    return null;
  }

  public createUser(userPayload: Omit<StoredUser, 'id' | 'registeredAt'> & { id?: string; password?: string }): UserProfile {
    const id = userPayload.id || `usr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const { password, ...restPayload } = userPayload as any;

    const newUser: StoredUser = {
      ...restPayload,
      id,
      registeredAt: now,
      status: userPayload.status || 'active',
      accountStatus: userPayload.accountStatus || 'approuve',
      passwordHash: password ? this.hashPassword(String(password)) : restPayload.passwordHash
    };

    this.data.users.push(newUser);
    this.persist();

    const { passwordHash, ...safe } = newUser;
    return safe as UserProfile;
  }

  public updateUser(id: string, updates: Partial<StoredUser>): UserProfile | null {
    const index = this.data.users.findIndex(u => u.id === id);
    if (index === -1) return null;

    this.data.users[index] = {
      ...this.data.users[index],
      ...updates
    };
    const { passwordHash, ...safe } = this.data.users[index];

    if (this.data.sessions) {
      for (const [tok, sess] of Object.entries(this.data.sessions)) {
        if (sess?.user?.id === id) {
          const updatedSess = { ...sess, user: { ...sess.user, ...safe } as UserProfile };
          this.data.sessions[tok] = updatedSess;
          this.sessions.set(tok, updatedSess);
        }
      }
    }

    this.persist();
    return safe as UserProfile;
  }

  public upsertUser(userPayload: StoredUser): UserProfile {
    const index = this.data.users.findIndex(
      u =>
        u.id === userPayload.id ||
        (userPayload.email && u.email?.toLowerCase() === userPayload.email.toLowerCase())
    );
    if (index !== -1) {
      this.data.users[index] = {
        ...this.data.users[index],
        ...userPayload
      };
      this.persist();
      const { passwordHash, ...safe } = this.data.users[index];
      return safe as UserProfile;
    }

    const newUser: StoredUser = {
      ...userPayload,
      registeredAt: userPayload.registeredAt || new Date().toISOString(),
      status: userPayload.status || 'active',
      accountStatus: userPayload.accountStatus || 'approuve'
    };
    this.data.users.push(newUser);
    this.persist();
    const { passwordHash, ...safe } = newUser;
    return safe as UserProfile;
  }

  public deleteClient(clientId: string, shopIds: string[] = []): boolean {
    const prevUsersLen = this.data.users.length;
    const prevShopsLen = this.data.shops.length;
    const prevPkgsLen = this.data.packages.length;

    const shopIdSet = new Set(shopIds.filter(Boolean));
    for (const s of this.data.shops) {
      if (s.user_id === clientId || s.id === clientId) {
        shopIdSet.add(s.id);
      }
    }

    const removedUsers = this.data.users.filter(u => u.id === clientId);
    this.data.users = this.data.users.filter(u => u.id !== clientId);
    this.data.shops = this.data.shops.filter(
      s => s.user_id !== clientId && s.id !== clientId && !shopIdSet.has(s.id)
    );
    this.data.packages = this.data.packages.filter(
      p => p.clientId !== clientId && (!p.shopId || !shopIdSet.has(p.shopId))
    );

    if (this.data.kycDocuments) {
      const keysToRemove = [clientId, ...Array.from(shopIdSet), ...removedUsers.map(u => u.email)]
        .filter(Boolean)
        .map(k => String(k).trim().toLowerCase());
      for (const k of keysToRemove) {
        delete this.data.kycDocuments[k];
      }
    }

    if (this.data.sessions) {
      for (const [tok, sess] of Object.entries(this.data.sessions)) {
        if (sess?.user?.id === clientId) {
          delete this.data.sessions[tok];
          this.sessions.delete(tok);
        }
      }
    }

    const changed =
      this.data.users.length !== prevUsersLen ||
      this.data.shops.length !== prevShopsLen ||
      this.data.packages.length !== prevPkgsLen;

    if (changed) {
      this.persist();
    }
    return changed;
  }

  public deleteDriver(driverId: string): boolean {
    const prevUsersLen = this.data.users.length;
    const removed = this.data.users.filter(u => u.id === driverId);
    this.data.users = this.data.users.filter(u => u.id !== driverId);

    this.data.packages = this.data.packages.map(p =>
      p.driverId === driverId ? { ...p, driverId: undefined, driverName: undefined } : p
    );

    if (this.data.kycDocuments) {
      const keysToRemove = [driverId, ...removed.map(u => u.email)]
        .filter(Boolean)
        .map(k => String(k).trim().toLowerCase());
      for (const k of keysToRemove) {
        delete this.data.kycDocuments[k];
      }
    }

    if (this.data.driverMeta) {
      const keysToRemove = [driverId, ...removed.map(u => u.email)]
        .filter(Boolean)
        .map(k => String(k).trim().toLowerCase());
      for (const k of keysToRemove) {
        delete this.data.driverMeta[k];
      }
    }

    if (this.data.sessions) {
      for (const [tok, sess] of Object.entries(this.data.sessions)) {
        if (sess?.user?.id === driverId) {
          delete this.data.sessions[tok];
          this.sessions.delete(tok);
        }
      }
    }

    const changed = this.data.users.length !== prevUsersLen;
    if (changed) {
      this.persist();
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // SESSIONS
  // ---------------------------------------------------------------------------
  public extractUserIdFromToken(token: string): string | null {
    if (!token || !token.startsWith('far_sec_')) return null;
    const parts = token.split('_');
    // Server format: far_sec_<userId>_<timestamp>_<rand>
    if (parts.length >= 5 && /^\d{10,}$/.test(parts[parts.length - 2])) {
      return parts.slice(2, -2).join('_');
    }
    // Client local format: far_sec_<userId>_<timestamp>
    if (parts.length >= 4 && /^\d{10,}$/.test(parts[parts.length - 1])) {
      return parts.slice(2, -1).join('_');
    }
    if (parts.length >= 3) {
      return parts[2];
    }
    return null;
  }

  public storeSession(
    token: string,
    user: UserProfile,
    ttlMs = 30 * 24 * 60 * 60 * 1000,
    meta?: { ip?: string; userAgent?: string }
  ): void {
    const expiresAt = Date.now() + ttlMs;
    const record: SessionRecord = {
      user,
      expiresAt,
      createdAt: new Date().toISOString(),
      ip: meta?.ip,
      userAgent: meta?.userAgent
    };
    this.sessions.set(token, record);
    if (!this.data.sessions) this.data.sessions = {};
    this.data.sessions[token] = record;
    this.persist();
  }

  public createSession(
    user: UserProfile,
    meta?: { ip?: string; userAgent?: string; ttlMs?: number; rememberMe?: boolean }
  ): string {
    const randomHex = crypto.randomBytes(24).toString('hex');
    const token = `far_sec_${user.id}_${randomHex}`;
    const defaultTtl = meta?.rememberMe === false ? 12 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    const ttlMs = typeof meta?.ttlMs === 'number' && meta.ttlMs > 0 ? meta.ttlMs : defaultTtl;
    this.storeSession(token, user, ttlMs, meta);
    return token;
  }

  public verifySession(token: string): UserProfile | null {
    if (!token) return null;

    // Strictly verify against real server-issued sessions (no token forgery fallback)
    const session = this.sessions.get(token) || this.data.sessions?.[token];
    if (!session || session.expiresAt <= Date.now()) {
      if (session) {
        this.sessions.delete(token);
        if (this.data.sessions?.[token]) {
          delete this.data.sessions[token];
          this.persist();
        }
      }
      return null;
    }

    // Check if user has been suspended or revoked since session was issued
    const storedUser = this.data.users.find(u => u.id === session.user?.id);
    if (storedUser && storedUser.role !== 'super_admin') {
      if (
        storedUser.status === 'suspendu' ||
        storedUser.status === 'inactive' ||
        ['suspendu', 'refuse', 'rejete', 'en_attente'].includes(String(storedUser.accountStatus || ''))
      ) {
        return null;
      }
    }

    this.sessions.set(token, session);
    return session.user;
  }

  public getSessionTokenId(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  public getActiveSessions(currentToken?: string): {
    sessionId: string;
    tokenPreview: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    createdAt?: string;
    expiresAt: number;
    ip?: string;
    userAgent?: string;
    isCurrent: boolean;
  }[] {
    const now = Date.now();
    const allTokens = new Map<string, SessionRecord>();
    for (const [tok, rec] of Object.entries(this.data.sessions || {})) {
      if (rec && rec.expiresAt > now) allTokens.set(tok, rec);
    }
    for (const [tok, rec] of this.sessions.entries()) {
      if (rec && rec.expiresAt > now) allTokens.set(tok, rec);
    }

    return Array.from(allTokens.entries()).map(([tok, rec]) => ({
      sessionId: this.getSessionTokenId(tok),
      tokenPreview: `${tok.slice(0, 14)}••••${tok.slice(-4)}`,
      userId: rec.user?.id || '',
      name: rec.user?.name || 'Utilisateur',
      email: rec.user?.email || '',
      role: rec.user?.role || 'client',
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      ip: rec.ip,
      userAgent: rec.userAgent,
      isCurrent: Boolean(currentToken && tok === currentToken)
    }));
  }

  public revokeSessionByToken(token: string): boolean {
    if (!token) return false;
    let removed = this.sessions.delete(token);
    if (this.data.sessions && this.data.sessions[token]) {
      delete this.data.sessions[token];
      removed = true;
    }
    if (removed) this.persist();
    return removed;
  }

  public revokeSessionById(sessionId: string): boolean {
    let removed = false;
    for (const tok of Array.from(this.sessions.keys())) {
      if (this.getSessionTokenId(tok) === sessionId) {
        this.sessions.delete(tok);
        removed = true;
      }
    }
    if (this.data.sessions) {
      for (const tok of Object.keys(this.data.sessions)) {
        if (this.getSessionTokenId(tok) === sessionId) {
          delete this.data.sessions[tok];
          removed = true;
        }
      }
    }
    if (removed) this.persist();
    return removed;
  }

  public revokeSessionsForUser(userId: string): number {
    let removedCount = 0;
    for (const [tok, rec] of Array.from(this.sessions.entries())) {
      if (rec?.user?.id === userId) {
        this.sessions.delete(tok);
        removedCount++;
      }
    }
    if (this.data.sessions) {
      for (const [tok, rec] of Object.entries(this.data.sessions)) {
        if (rec?.user?.id === userId) {
          delete this.data.sessions[tok];
          removedCount++;
        }
      }
    }
    if (removedCount > 0) this.persist();
    return removedCount;
  }

  public revokeAllSessions(exceptToken?: string): number {
    let count = 0;
    const keptSession = exceptToken ? this.sessions.get(exceptToken) || this.data.sessions?.[exceptToken] : undefined;
    count = Object.keys(this.data.sessions || {}).length;
    this.sessions.clear();
    this.data.sessions = {};
    if (exceptToken && keptSession) {
      this.sessions.set(exceptToken, keptSession);
      this.data.sessions[exceptToken] = keptSession;
      count = Math.max(0, count - 1);
    }
    this.persist();
    return count;
  }

  public isDefaultAdminPassword(): boolean {
    const admin = this.data.users.find(
      u => u.email?.toLowerCase() === INITIAL_ADMIN.email.toLowerCase() || u.role === 'super_admin'
    );
    if (!admin || !admin.passwordHash) return true;
    return this.verifyPassword('admin123', admin.passwordHash);
  }

  public changeUserPassword(userIdOrEmail: string, newPlainPassword: string): boolean {
    const cleanTarget = (userIdOrEmail || '').trim().toLowerCase();
    let idx = this.data.users.findIndex(
      u => u.id === userIdOrEmail || (u.email || '').toLowerCase() === cleanTarget
    );
    if (idx === -1 && cleanTarget === INITIAL_ADMIN.email.toLowerCase()) {
      this.data.users.unshift({ ...INITIAL_ADMIN });
      idx = 0;
    }
    if (idx === -1) return false;
    this.data.users[idx].passwordHash = this.hashPassword(newPlainPassword);
    if (this.data.users[idx].email?.toLowerCase() === INITIAL_ADMIN.email.toLowerCase()) {
      const sec = this.getSecuritySettings();
      this.data.securitySettings = { ...sec, adminPasswordChanged: true, updatedAt: new Date().toISOString() };
    }
    this.persist();
    return true;
  }

  public verifyUserPassword(userIdOrEmail: string, plainPassword: string): boolean {
    const cleanTarget = (userIdOrEmail || '').trim().toLowerCase();
    const user = this.data.users.find(
      u => u.id === userIdOrEmail || (u.email || '').toLowerCase() === cleanTarget
    );
    if (!user) {
      if (cleanTarget === INITIAL_ADMIN.email.toLowerCase()) {
        return this.verifyPassword(plainPassword, INITIAL_ADMIN.passwordHash);
      }
      return false;
    }
    return this.verifyPassword(plainPassword, user.passwordHash);
  }

  public deleteUserById(userId: string): boolean {
    const target = this.data.users.find(u => u.id === userId);
    if (!target) return false;
    if (target.role === 'super_admin' || target.email?.toLowerCase() === INITIAL_ADMIN.email.toLowerCase()) {
      return false;
    }
    this.data.users = this.data.users.filter(u => u.id !== userId);
    if (this.data.sessions) {
      for (const [tok, rec] of Object.entries(this.data.sessions)) {
        if (rec?.user?.id === userId) {
          delete this.data.sessions[tok];
          this.sessions.delete(tok);
        }
      }
    }
    this.persist();
    return true;
  }

  public getSecuritySettings(): SecuritySettings {
    if (!this.data.securitySettings) {
      this.data.securitySettings = {
        requireAdminApprovalForClients: true,
        allowPublicClientRegistration: true,
        allowPublicDriverRegistration: true,
        adminPasswordChanged: !this.isDefaultAdminPassword()
      };
    }
    return this.data.securitySettings;
  }

  public saveSecuritySettings(updates: Partial<SecuritySettings>): SecuritySettings {
    const current = this.getSecuritySettings();
    this.data.securitySettings = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    this.persist();
    return this.data.securitySettings;
  }

  // ---------------------------------------------------------------------------
  // SHOPS
  // ---------------------------------------------------------------------------
  public getShops(): StoredShop[] {
    return this.data.shops;
  }

  public getShopByUserId(userId: string): StoredShop | null {
    return this.data.shops.find(s => s.user_id === userId) || null;
  }

  public createShop(shopData: Omit<StoredShop, 'id' | 'created_at' | 'updated_at'>): StoredShop {
    const id = `shop-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();

    const newShop: StoredShop = {
      ...shopData,
      id,
      created_at: now,
      updated_at: now
    };

    this.data.shops.push(newShop);
    this.persist();
    return newShop;
  }

  // ---------------------------------------------------------------------------
  // PACKAGES
  // ---------------------------------------------------------------------------
  public getPackages(filter?: { clientId?: string; shopId?: string; ownerIds?: string[]; driverId?: string }): PackageItem[] {
    let result = [...this.data.packages];
    if (filter?.ownerIds && filter.ownerIds.length > 0) {
      const idSet = new Set(filter.ownerIds.filter(Boolean).map(v => String(v)));
      result = result.filter(p => idSet.has(String(p.clientId)) || ((p as any).shopId && idSet.has(String((p as any).shopId))));
    } else {
      if (filter?.clientId) {
        result = result.filter(p => p.clientId === filter.clientId);
      }
      if (filter?.shopId) {
        result = result.filter(p => (p as any).shopId === filter.shopId);
      }
    }
    if (filter?.driverId) {
      result = result.filter(p => p.driverId === filter.driverId);
    }
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public getPackageByIdOrTracking(query: string): PackageItem | null {
    const clean = (query || '').trim().toUpperCase();
    return (
      this.data.packages.find(
        p => p.trackingNumber.toUpperCase() === clean || p.id.toUpperCase() === clean
      ) || null
    );
  }

  public createPackage(pkg: Omit<PackageItem, 'id' | 'trackingNumber' | 'createdAt' | 'lastMovedAt' | 'history'>): PackageItem {
    const id = `pkg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const trackingNumber = `FAR-${Math.floor(10000000 + Math.random() * 90000000)}`;
    const now = new Date().toISOString();

    const newPackage: PackageItem = {
      ...pkg,
      id,
      trackingNumber,
      createdAt: now,
      lastMovedAt: now,
      history: [
        {
          id: `hist-${Date.now()}`,
          status: pkg.status || 'nouveau',
          statusLabel: 'Nouveau colis créé',
          updatedBy: 'FARIOUSY Logistics',
          role: 'admin',
          timestamp: now,
          location: pkg.city || 'Hub Central',
          comment: 'Colis créé et enregistré dans le système FARIOUSY DELIVERY'
        }
      ]
    };

    this.data.packages.unshift(newPackage);
    this.persist();
    return newPackage;
  }

  public updatePackageStatus(packageId: string, status: any, comment?: string, location?: string): PackageItem | null {
    const pkg = this.data.packages.find(p => p.id === packageId || p.trackingNumber === packageId);
    if (!pkg) return null;

    const now = new Date().toISOString();
    pkg.status = status;
    pkg.lastMovedAt = now;

    if (!Array.isArray(pkg.history)) {
      pkg.history = [];
    }

    pkg.history.unshift({
      id: `hist-${Date.now()}`,
      status,
      statusLabel: `Statut : ${status}`,
      updatedBy: 'Administration FARIOUSY',
      role: 'admin',
      timestamp: now,
      location: location || pkg.currentAgency || pkg.city || 'Hub Central',
      comment: comment || `Mise à jour du statut : ${status}`
    });

    this.persist();
    return pkg;
  }

  public assignDriver(packageId: string, driverId: string, driverName?: string): PackageItem | null {
    const pkg = this.data.packages.find(p => p.id === packageId || p.trackingNumber === packageId);
    if (!pkg) return null;

    const now = new Date().toISOString();
    pkg.driverId = driverId;
    if (driverName) {
      pkg.driverName = driverName;
    }
    pkg.lastMovedAt = now;

    if (!Array.isArray(pkg.history)) {
      pkg.history = [];
    }

    pkg.history.unshift({
      id: `hist-${Date.now()}`,
      status: pkg.status,
      statusLabel: 'Affecté à un livreur',
      updatedBy: 'Administration FARIOUSY',
      role: 'admin',
      timestamp: now,
      location: pkg.currentAgency || 'Hub Central',
      comment: `Colis assigné au livreur : ${driverName || driverId}`
    });

    this.persist();
    return pkg;
  }

  public updatePackage(idOrTracking: string, updates: Partial<PackageItem>): PackageItem | null {
    const clean = (idOrTracking || '').trim();
    const idx = this.data.packages.findIndex(p => p.id === clean || p.trackingNumber === clean);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    const updated: PackageItem = {
      ...this.data.packages[idx],
      ...updates,
      lastMovedAt: updates.lastMovedAt || now
    };
    this.data.packages[idx] = updated;
    this.persist();
    return updated;
  }

  public deletePackage(packageIdOrTracking: string): boolean {
    const clean = (packageIdOrTracking || '').trim().toUpperCase();
    if (!clean) return false;

    const target = this.data.packages.find(
      p => p.id.toUpperCase() === clean || p.trackingNumber.toUpperCase() === clean
    );
    const prevLen = this.data.packages.length;
    this.data.packages = this.data.packages.filter(
      p => p.id.toUpperCase() !== clean && p.trackingNumber.toUpperCase() !== clean
    );

    if (this.data.problemReports) {
      delete this.data.problemReports[packageIdOrTracking];
      if (target) {
        delete this.data.problemReports[target.id];
        delete this.data.problemReports[target.trackingNumber];
      }
    }

    if (this.data.packageOptions) {
      delete this.data.packageOptions[packageIdOrTracking.trim().toLowerCase()];
      delete this.data.packageOptions[packageIdOrTracking];
      if (target) {
        delete this.data.packageOptions[target.id.toLowerCase()];
        delete this.data.packageOptions[target.trackingNumber.toLowerCase()];
      }
    }

    if (this.data.packageOverrides) {
      delete this.data.packageOverrides[packageIdOrTracking.trim().toLowerCase()];
      delete this.data.packageOverrides[packageIdOrTracking];
      if (target) {
        delete this.data.packageOverrides[target.id.toLowerCase()];
        delete this.data.packageOverrides[target.trackingNumber.toLowerCase()];
      }
    }

    const changed = this.data.packages.length !== prevLen;
    if (changed || target) {
      this.persist();
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // PACKAGE OVERRIDES (Persistent edits/history/agency/partner fields for DB packages)
  // ---------------------------------------------------------------------------
  public savePackageOverrides(
    keys: (string | undefined | null)[],
    patch: Partial<PackageItem>
  ): Partial<PackageItem> {
    if (!this.data.packageOverrides) {
      this.data.packageOverrides = {};
    }
    const existing = this.getPackageOverrides(keys) || {};
    const cleanPatch: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (v !== undefined) {
        cleanPatch[k] = v;
      }
    }
    const merged: Partial<PackageItem> = {
      ...existing,
      ...cleanPatch,
      lastMovedAt: patch.lastMovedAt || new Date().toISOString()
    };

    if (Array.isArray(patch.history) && patch.history.length > 0) {
      const prevHist = Array.isArray(existing.history) ? existing.history : [];
      const seen = new Set(prevHist.map(h => h.id));
      const combined = [...prevHist];
      for (const item of patch.history) {
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          combined.push(item);
        }
      }
      merged.history = combined;
    }

    const normalizedKeys = new Set<string>();
    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        normalizedKeys.add(rawKey.trim().toLowerCase());
      }
    }
    for (const k of normalizedKeys) {
      this.data.packageOverrides[k] = merged;
    }

    this.persist();
    return merged;
  }

  public getPackageOverrides(keys: (string | undefined | null)[]): Partial<PackageItem> | null {
    if (!this.data.packageOverrides) return null;
    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        const trimmed = rawKey.trim();
        const normalized = trimmed.toLowerCase();
        if (this.data.packageOverrides[normalized]) {
          return this.data.packageOverrides[normalized];
        }
        if (this.data.packageOverrides[trimmed]) {
          return this.data.packageOverrides[trimmed];
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // PACKAGE DELIVERY OPTIONS (Ouvrir le colis / Essayage / Échange)
  // ---------------------------------------------------------------------------
  public savePackageOptions(
    keys: (string | undefined | null)[],
    opts: PackageOptionsRecord
  ): PackageOptionsRecord {
    if (!this.data.packageOptions) {
      this.data.packageOptions = {};
    }
    const existing = this.getPackageOptions(keys);
    const merged: PackageOptionsRecord = {
      allowOpen: opts.allowOpen !== undefined ? Boolean(opts.allowOpen) : existing?.allowOpen,
      allowTry: opts.allowTry !== undefined ? Boolean(opts.allowTry) : existing?.allowTry,
      isFragile: opts.isFragile !== undefined ? Boolean(opts.isFragile) : existing?.isFragile,
      isExchange: opts.isExchange !== undefined ? Boolean(opts.isExchange) : existing?.isExchange,
      exchangeTrackingNumber:
        opts.exchangeTrackingNumber !== undefined
          ? opts.exchangeTrackingNumber
          : existing?.exchangeTrackingNumber,
      exchangeReason: opts.exchangeReason !== undefined ? opts.exchangeReason : existing?.exchangeReason,
      exchangeItemDescription:
        opts.exchangeItemDescription !== undefined
          ? opts.exchangeItemDescription
          : existing?.exchangeItemDescription,
      updatedAt: new Date().toISOString()
    };

    const normalizedKeys = new Set<string>();
    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        normalizedKeys.add(rawKey.trim().toLowerCase());
      }
    }

    for (const k of normalizedKeys) {
      this.data.packageOptions[k] = merged;
    }

    // Sync matching local packages
    for (const pkg of this.data.packages) {
      if (
        normalizedKeys.has(pkg.id.toLowerCase()) ||
        normalizedKeys.has(pkg.trackingNumber.toLowerCase())
      ) {
        pkg.allowOpen = merged.allowOpen;
        pkg.allowTry = merged.allowTry;
        pkg.isFragile = merged.isFragile;
        pkg.isExchange = merged.isExchange;
        if (merged.exchangeTrackingNumber !== undefined) {
          pkg.exchangeTrackingNumber = merged.exchangeTrackingNumber;
        }
        if (merged.exchangeReason !== undefined) {
          pkg.exchangeReason = merged.exchangeReason;
        }
        if (merged.exchangeItemDescription !== undefined) {
          pkg.exchangeItemDescription = merged.exchangeItemDescription;
        }
      }
    }

    this.persist();
    return merged;
  }

  public getPackageOptions(keys: (string | undefined | null)[]): PackageOptionsRecord | null {
    if (!this.data.packageOptions) return null;
    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        const normalized = rawKey.trim().toLowerCase();
        if (this.data.packageOptions[normalized]) {
          return this.data.packageOptions[normalized];
        }
        if (this.data.packageOptions[rawKey.trim()]) {
          return this.data.packageOptions[rawKey.trim()];
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // AUDIT LOGS
  // ---------------------------------------------------------------------------
  public addAuditLog(action: string, entity: string, entityId: string, details?: any, author?: any) {
    const log = {
      id: `log-${Date.now()}`,
      action,
      entity,
      entityId,
      details,
      author,
      timestamp: new Date().toISOString()
    };
    this.data.auditLogs.unshift(log);
    if (this.data.auditLogs.length > 500) {
      this.data.auditLogs = this.data.auditLogs.slice(0, 500);
    }
    this.persist();
    return log;
  }

  // ---------------------------------------------------------------------------
  // PROBLEM REPORTS WITH PHOTOS (حالة مشكلة في التوصيل)
  // ---------------------------------------------------------------------------
  public getProblemReports(): Record<string, PackageProblemReport> {
    return this.data.problemReports || {};
  }

  public saveProblemReport(packageId: string, report: PackageProblemReport): PackageProblemReport {
    if (!this.data.problemReports) {
      this.data.problemReports = {};
    }
    this.data.problemReports[packageId] = report;

    const pkg = this.data.packages.find(p => p.id === packageId || p.trackingNumber === packageId);
    if (pkg) {
      pkg.problemReport = report;
      if (report.photoBase64) {
        pkg.callProofUrl = report.photoBase64;
      }
      pkg.driverComment = report.description;
    }
    this.persist();
    return report;
  }

  public resolveProblemReport(packageId: string, resolvedBy: string, adminNote?: string): PackageProblemReport | null {
    if (!this.data.problemReports || !this.data.problemReports[packageId]) return null;
    const existing = this.data.problemReports[packageId];
    const updated: PackageProblemReport = {
      ...existing,
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
      adminNote: adminNote || existing.adminNote
    };
    this.data.problemReports[packageId] = updated;
    const pkg = this.data.packages.find(p => p.id === packageId || p.trackingNumber === packageId);
    if (pkg) {
      pkg.problemReport = updated;
    }
    this.persist();
    return updated;
  }

  // ---------------------------------------------------------------------------
  // KYC DOCUMENTS (CIN PHOTOS & DRIVER PERSONAL PHOTO)
  // ---------------------------------------------------------------------------
  public saveKycDocuments(
    keys: (string | undefined | null)[],
    docs: Partial<KycDocumentRecord>
  ): KycDocumentRecord {
    if (!this.data.kycDocuments) {
      this.data.kycDocuments = {};
    }
    const existing = this.getKycDocuments(keys);
    const merged: KycDocumentRecord = {
      cinNumber: docs.cinNumber ?? existing?.cinNumber,
      cinPhotoUrl: docs.cinPhotoUrl ?? existing?.cinPhotoUrl,
      cinBackPhotoUrl: docs.cinBackPhotoUrl ?? existing?.cinBackPhotoUrl,
      driverPhotoUrl: docs.driverPhotoUrl ?? existing?.driverPhotoUrl,
      bankName: docs.bankName !== undefined ? docs.bankName : existing?.bankName,
      bankRib: docs.bankRib !== undefined ? docs.bankRib : existing?.bankRib,
      updatedAt: new Date().toISOString()
    };

    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        const normalized = rawKey.trim().toLowerCase();
        this.data.kycDocuments[normalized] = merged;
      }
    }
    this.persist();
    return merged;
  }

  public getKycDocuments(keys: (string | undefined | null)[]): KycDocumentRecord | null {
    if (!this.data.kycDocuments) return null;
    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        const normalized = rawKey.trim().toLowerCase();
        if (this.data.kycDocuments[normalized]) {
          return this.data.kycDocuments[normalized];
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // DRIVER META (Salary, fees, address, whatsapp persisted for Supabase/local drivers)
  // ---------------------------------------------------------------------------
  public saveDriverMeta(
    keys: (string | undefined | null)[],
    meta: Partial<DriverMetaRecord>
  ): DriverMetaRecord {
    if (!this.data.driverMeta) {
      this.data.driverMeta = {};
    }
    const existing = this.getDriverMeta(keys) || {};
    const merged: DriverMetaRecord = {
      ...existing,
      ...(meta.driverFeePerDelivery !== undefined ? { driverFeePerDelivery: Number(meta.driverFeePerDelivery) } : {}),
      ...(meta.driverFixedSalary !== undefined ? { driverFixedSalary: Number(meta.driverFixedSalary) } : {}),
      ...(meta.driverSalaryType !== undefined ? { driverSalaryType: meta.driverSalaryType } : {}),
      ...(meta.driverPickupFee !== undefined ? { driverPickupFee: Number(meta.driverPickupFee) } : {}),
      ...(meta.driverBonusThreshold !== undefined ? { driverBonusThreshold: Number(meta.driverBonusThreshold) } : {}),
      ...(meta.driverBonusAmount !== undefined ? { driverBonusAmount: Number(meta.driverBonusAmount) } : {}),
      ...(meta.address !== undefined ? { address: meta.address } : {}),
      ...(meta.whatsapp !== undefined ? { whatsapp: meta.whatsapp } : {}),
      ...(meta.driverVehicle !== undefined ? { driverVehicle: meta.driverVehicle } : {}),
      ...(meta.driverPlate !== undefined ? { driverPlate: meta.driverPlate } : {}),
      updatedAt: new Date().toISOString()
    };

    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        this.data.driverMeta[rawKey.trim().toLowerCase()] = merged;
      }
    }
    this.persist();
    return merged;
  }

  public getDriverMeta(keys: (string | undefined | null)[]): DriverMetaRecord | null {
    if (!this.data.driverMeta) return null;
    for (const rawKey of keys) {
      if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
        const normalized = rawKey.trim().toLowerCase();
        if (this.data.driverMeta[normalized]) {
          return this.data.driverMeta[normalized];
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // PARTNER SECRETS & USER SAVED ADDRESSES
  // ---------------------------------------------------------------------------
  public savePartnerSecrets(partnerId: string, secrets: Partial<PartnerSecretRecord>): PartnerSecretRecord {
    if (!this.data.partnerSecrets) {
      this.data.partnerSecrets = {};
    }
    const existing = this.data.partnerSecrets[partnerId] || {};
    const isMasked = (val?: string) => typeof val === 'string' && val.includes('••••');
    const merged: PartnerSecretRecord = {
      ...existing,
      ...(secrets.apiKey !== undefined && !isMasked(secrets.apiKey) ? { apiKey: secrets.apiKey } : {}),
      ...(secrets.apiSecret !== undefined && !isMasked(secrets.apiSecret) ? { apiSecret: secrets.apiSecret } : {}),
      ...(secrets.password !== undefined && !isMasked(secrets.password) ? { password: secrets.password } : {}),
      ...(secrets.webhookSecret !== undefined && !isMasked(secrets.webhookSecret) ? { webhookSecret: secrets.webhookSecret } : {}),
      ...(secrets.webhookToken !== undefined && !isMasked(secrets.webhookToken) ? { webhookToken: secrets.webhookToken } : {}),
      updatedAt: new Date().toISOString()
    };
    this.data.partnerSecrets[partnerId] = merged;
    this.persist();
    return merged;
  }

  public getPartnerSecrets(partnerId: string): PartnerSecretRecord | null {
    return this.data.partnerSecrets?.[partnerId] || null;
  }

  public deletePartnerSecret(partnerId: string): void {
    if (this.data.partnerSecrets?.[partnerId]) {
      delete this.data.partnerSecrets[partnerId];
      this.persist();
    }
  }

  public getUserSavedAddresses(userId?: string): SavedAddress[] {
    if (!this.data.userSavedAddresses) {
      this.data.userSavedAddresses = {};
    }
    if (userId) {
      return Array.isArray(this.data.userSavedAddresses[userId]) ? this.data.userSavedAddresses[userId] : [];
    }
    const all: SavedAddress[] = [];
    for (const list of Object.values(this.data.userSavedAddresses)) {
      if (Array.isArray(list)) all.push(...list);
    }
    return all;
  }

  public saveUserSavedAddresses(userId: string, addresses: SavedAddress[]): SavedAddress[] {
    if (!this.data.userSavedAddresses) {
      this.data.userSavedAddresses = {};
    }
    this.data.userSavedAddresses[userId] = Array.isArray(addresses) ? addresses : [];
    this.persist();
    return this.data.userSavedAddresses[userId];
  }

  // ---------------------------------------------------------------------------
  // COMPANY SETTINGS PERSISTENCE
  // ---------------------------------------------------------------------------
  public getCompanySettings(): CompanySettings | null {
    return this.data.companySettings || null;
  }

  public saveCompanySettings(partial: Partial<CompanySettings>, defaults?: CompanySettings): CompanySettings {
    const base = this.data.companySettings || defaults || ({} as CompanySettings);
    const updated: CompanySettings = {
      ...base,
      ...partial
    };
    this.data.companySettings = updated;
    this.persist();
    return updated;
  }

  // ---------------------------------------------------------------------------
  // CUSTOMER & DRIVER REVIEWS PERSISTENCE
  // ---------------------------------------------------------------------------
  public getReviews(): CustomerReview[] {
    if (!Array.isArray(this.data.reviews)) {
      return [];
    }
    return [...this.data.reviews].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public addReview(review: CustomerReview): CustomerReview {
    if (!Array.isArray(this.data.reviews)) {
      this.data.reviews = [];
    }
    this.data.reviews.unshift(review);
    this.persist();
    return review;
  }

  public updateReview(id: string, updates: Partial<CustomerReview>): CustomerReview | null {
    if (!Array.isArray(this.data.reviews)) return null;
    const idx = this.data.reviews.findIndex(r => r.id === id);
    if (idx === -1) return null;
    this.data.reviews[idx] = { ...this.data.reviews[idx], ...updates, id };
    this.persist();
    return this.data.reviews[idx];
  }

  public deleteReview(id: string): boolean {
    if (!Array.isArray(this.data.reviews)) return false;
    const before = this.data.reviews.length;
    this.data.reviews = this.data.reviews.filter(r => r.id !== id);
    if (this.data.reviews.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // CLIENT FULFILLMENT STOCK (السطوك عند الزبون بالأكواد والفواتير)
  // ---------------------------------------------------------------------------
  private ensureClientStockArrays() {
    if (!Array.isArray(this.data.clientStockProducts)) this.data.clientStockProducts = [];
    if (!Array.isArray(this.data.clientStockMovements)) this.data.clientStockMovements = [];
    if (!Array.isArray(this.data.clientStockInvoices)) this.data.clientStockInvoices = [];
  }

  public getClientStockData(clientId?: string, altClientId?: string) {
    this.ensureClientStockArrays();
    const cleanId = typeof clientId === 'string' ? clientId.trim() : '';
    const cleanAlt = typeof altClientId === 'string' ? altClientId.trim() : '';
    const matchClient = (cId?: string) => {
      if (!cleanId && !cleanAlt) return true;
      if (!cId) return false;
      return cId === cleanId || (Boolean(cleanAlt) && cId === cleanAlt);
    };

    const products = [...this.data.clientStockProducts!]
      .filter(p => matchClient(p.clientId))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const movements = [...this.data.clientStockMovements!]
      .filter(m => matchClient(m.clientId))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const invoices = [...this.data.clientStockInvoices!]
      .filter(inv => matchClient(inv.clientId))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return { products, movements, invoices };
  }

  private generateUnitBatch(
    productId: string,
    clientId: string,
    skuToken: string,
    startSeq: number,
    count: number,
    hubName?: string
  ): ClientStockUnit[] {
    const now = new Date().toISOString();
    const units: ClientStockUnit[] = [];
    for (let i = 0; i < count; i++) {
      const seq = String(startSeq + i).padStart(3, '0');
      units.push({
        id: `unit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}-${seq}`,
        unitCode: `FSU-${skuToken}-${seq}`,
        productId,
        clientId,
        status: 'en_attente',
        hubName: hubName || 'Hub Central Casablanca',
        createdAt: now
      });
    }
    return units;
  }

  public createClientStockProduct(payload: {
    clientId: string;
    clientName?: string;
    clientCompany?: string;
    name: string;
    photoUrl?: string;
    category?: string;
    unitPrice: number;
    quantity: number;
    hubName?: string;
    notes?: string;
    actorName?: string;
  }): { product: ClientStockProduct; movement: ClientStockMovement } {
    this.ensureClientStockArrays();
    const now = new Date();
    const nowIso = now.toISOString();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    const skuToken = `${yy}${mm}${dd}-${rand}`;
    const productId = `stkprod-${Date.now()}-${rand.toLowerCase()}`;
    const qty = Math.max(1, Math.min(500, Math.floor(Number(payload.quantity) || 1)));

    const units = this.generateUnitBatch(
      productId,
      payload.clientId,
      skuToken,
      1,
      qty,
      payload.hubName
    );

    const product: ClientStockProduct = {
      id: productId,
      clientId: payload.clientId,
      clientName: payload.clientName,
      clientCompany: payload.clientCompany,
      skuCode: `SKU-${skuToken}`,
      name: payload.name.trim(),
      photoUrl: payload.photoUrl,
      category: payload.category?.trim() || undefined,
      unitPrice: Math.max(0, Math.round((Number(payload.unitPrice) || 0) * 100) / 100),
      hubName: payload.hubName || 'Hub Central Casablanca',
      initialQuantity: qty,
      units,
      notes: payload.notes?.trim() || undefined,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    const movement: ClientStockMovement = {
      id: `stkmov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      productId: product.id,
      productName: product.name,
      clientId: product.clientId,
      type: 'entree_creation',
      quantity: qty,
      unitCodes: units.map(u => u.unitCode),
      actorName: payload.actorName || payload.clientCompany || payload.clientName || 'Client',
      notes: `إضافة منتوج جديد (${qty} قطعة) وتوليد ${qty} كود سكان خاص بكل قطعة`,
      createdAt: nowIso
    };

    this.data.clientStockProducts!.unshift(product);
    this.data.clientStockMovements!.unshift(movement);
    this.persist();
    return { product, movement };
  }

  public addUnitsToClientStockProduct(
    productId: string,
    addQty: number,
    actorName?: string
  ): { product: ClientStockProduct; movement: ClientStockMovement; addedUnits: ClientStockUnit[] } | null {
    this.ensureClientStockArrays();
    const idx = this.data.clientStockProducts!.findIndex(p => p.id === productId);
    if (idx === -1) return null;

    const prod = this.data.clientStockProducts![idx];
    const qty = Math.max(1, Math.min(500, Math.floor(Number(addQty) || 1)));
    const skuToken = prod.skuCode.replace(/^SKU-/, '');
    const startSeq = prod.units.length + 1;
    const newUnits = this.generateUnitBatch(
      prod.id,
      prod.clientId,
      skuToken,
      startSeq,
      qty,
      prod.hubName
    );

    const nowIso = new Date().toISOString();
    prod.units = [...prod.units, ...newUnits];
    prod.initialQuantity = prod.units.length;
    prod.updatedAt = nowIso;

    const movement: ClientStockMovement = {
      id: `stkmov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      productId: prod.id,
      productName: prod.name,
      clientId: prod.clientId,
      type: 'ajout_quantite',
      quantity: qty,
      unitCodes: newUnits.map(u => u.unitCode),
      actorName: actorName || prod.clientCompany || prod.clientName || 'Client',
      notes: `إضافة +${qty} قطعة إضافية للسطوك وتوليد أكوادها`,
      createdAt: nowIso
    };

    this.data.clientStockMovements!.unshift(movement);
    this.persist();
    return { product: prod, movement, addedUnits: newUnits };
  }

  public scanClientStockUnit(
    codeOrProductId: string,
    opts?: {
      hubName?: string;
      zone?: string;
      shelf?: string;
      bin?: string;
      actorName?: string;
      scanAllPending?: boolean;
    }
  ): {
    success: boolean;
    message: string;
    product?: ClientStockProduct;
    unit?: ClientStockUnit;
    scannedUnits?: ClientStockUnit[];
  } {
    this.ensureClientStockArrays();
    const clean = (codeOrProductId || '').trim().toUpperCase();
    if (!clean) {
      return { success: false, message: 'يرجى إدخال أو مسح كود القطعة.' };
    }

    const nowIso = new Date().toISOString();

    // 1. Batch scan all pending units for a product (by productId or SKU code)
    if (opts?.scanAllPending) {
      const prod = this.data.clientStockProducts!.find(
        p => p.id.toUpperCase() === clean || p.skuCode.toUpperCase() === clean
      );
      if (!prod) {
        return { success: false, message: `المنتوج (${clean}) غير موجود في السطوك.` };
      }
      const pending = prod.units.filter(u => u.status === 'en_attente');
      if (pending.length === 0) {
        return { success: false, message: `جميع قطع "${prod.name}" تم سكانها ووضعها في السطوك مسبقاً.` };
      }
      pending.forEach(u => {
        u.status = 'en_stock';
        u.hubName = opts.hubName || prod.hubName || 'Hub Central Casablanca';
        u.zone = opts.zone || u.zone || 'Zone A';
        u.shelf = opts.shelf || u.shelf || 'Rayon 01';
        u.bin = opts.bin || u.bin || 'Bac 01';
        u.scannedAt = nowIso;
        u.scannedBy = opts.actorName || 'Entrepôt';
      });
      prod.updatedAt = nowIso;

      this.data.clientStockMovements!.unshift({
        id: `stkmov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        productId: prod.id,
        productName: prod.name,
        clientId: prod.clientId,
        type: 'scan_stock',
        quantity: pending.length,
        unitCodes: pending.map(u => u.unitCode),
        actorName: opts.actorName || 'Entrepôt',
        notes: `تأكيد سكان ${pending.length} قطعة وإدخالها للمستودع (${opts.hubName || prod.hubName || 'Hub'})`,
        createdAt: nowIso
      });

      this.persist();
      return {
        success: true,
        message: `تم سكان وإدخال ${pending.length} قطعة من "${prod.name}" إلى السطوك بنجاح.`,
        product: prod,
        scannedUnits: pending
      };
    }

    // 2. Match exact unitCode
    for (const prod of this.data.clientStockProducts!) {
      const unit = prod.units.find(u => u.unitCode.toUpperCase() === clean);
      if (unit) {
        if (unit.status === 'en_stock') {
          return {
            success: false,
            message: `القطعة ${unit.unitCode} (${prod.name}) موجودة بالفعل فالسطوك منذ ${new Date(unit.scannedAt || unit.createdAt).toLocaleDateString('fr-FR')}.`,
            product: prod,
            unit
          };
        }
        if (unit.status === 'expedie') {
          return {
            success: false,
            message: `القطعة ${unit.unitCode} (${prod.name}) تم سحبها وشحنها بالفعل في الكوليا ${unit.packageTrackingNumber || ''}.`,
            product: prod,
            unit
          };
        }

        unit.status = 'en_stock';
        unit.hubName = opts?.hubName || prod.hubName || 'Hub Central Casablanca';
        unit.zone = opts?.zone || 'Zone A';
        unit.shelf = opts?.shelf || 'Rayon 01';
        unit.bin = opts?.bin || 'Bac 01';
        unit.scannedAt = nowIso;
        unit.scannedBy = opts?.actorName || 'Scanner';
        prod.updatedAt = nowIso;

        this.data.clientStockMovements!.unshift({
          id: `stkmov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          productId: prod.id,
          productName: prod.name,
          clientId: prod.clientId,
          type: 'scan_stock',
          quantity: 1,
          unitCodes: [unit.unitCode],
          actorName: opts?.actorName || 'Scanner',
          notes: `سكان قطعة ${unit.unitCode} ووضعها فالسطوك (${unit.hubName} - ${unit.zone}/${unit.shelf}/${unit.bin})`,
          createdAt: nowIso
        });

        this.persist();
        const inStockNow = prod.units.filter(u => u.status === 'en_stock').length;
        return {
          success: true,
          message: `✅ تم سكان القطعة ${unit.unitCode} (${prod.name}) ووضعها فالسطوك! المتوفر الآن: ${inStockNow}/${prod.units.length}`,
          product: prod,
          unit,
          scannedUnits: [unit]
        };
      }
    }

    // 3. Fallback: Match SKU code -> scan next en_attente unit
    const skuProd = this.data.clientStockProducts!.find(p => p.skuCode.toUpperCase() === clean);
    if (skuProd) {
      const nextPending = skuProd.units.find(u => u.status === 'en_attente');
      if (!nextPending) {
        return {
          success: false,
          message: `لا توجد قطع متبقية في انتظار السكان للمنتوج "${skuProd.name}" (${skuProd.skuCode}).`,
          product: skuProd
        };
      }
      return this.scanClientStockUnit(nextPending.unitCode, opts);
    }

    return {
      success: false,
      message: `الكود ${clean} غير مطابق لأي قطعة مسجلة في سطوك الزبناء.`
    };
  }

  public deductClientStockForPackage(payload: {
    clientId: string;
    shopId?: string;
    clientName: string;
    clientCompany?: string;
    clientPhone?: string;
    packageId: string;
    trackingNumber: string;
    recipientName: string;
    recipientCity: string;
    deliveryFee: number;
    items: { productId: string; quantity: number }[];
    actorName?: string;
  }): {
    success: boolean;
    invoice?: ClientStockInvoice;
    updatedProducts?: ClientStockProduct[];
    movements?: ClientStockMovement[];
    error?: string;
  } {
    this.ensureClientStockArrays();
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return { success: false, error: 'يرجى تحديد منتوج واحد على الأقل من السطوك.' };
    }

    const cleanClientId = String(payload.clientId || '').trim();
    const cleanShopId = String(payload.shopId || '').trim();
    if (!cleanClientId && !cleanShopId) {
      return { success: false, error: 'معرف الزبون غير صالح لخصم السطوك.' };
    }

    // Step 1: Validate strict ownership & stock availability before mutating
    const plannedSelections: {
      prod: ClientStockProduct;
      unitsToDeduct: ClientStockUnit[];
      qty: number;
    }[] = [];

    for (const item of payload.items) {
      const qty = Math.max(1, Math.floor(Number(item.quantity) || 0));
      const prod = this.data.clientStockProducts!.find(p => p.id === item.productId);
      if (!prod) {
        return { success: false, error: 'المنتوج المختار غير موجود في السطوك.' };
      }
      const belongsToClient =
        (cleanClientId && prod.clientId === cleanClientId) ||
        (cleanShopId && prod.clientId === cleanShopId);
      if (!belongsToClient) {
        return {
          success: false,
          error: `المنتوج "${prod.name}" لا ينتمي إلى حساب هذا الزبون ولا يمكن خصمه.`
        };
      }
      const availableInStock = prod.units.filter(u => u.status === 'en_stock');
      if (availableInStock.length < qty) {
        const pendingCount = prod.units.filter(u => u.status === 'en_attente').length;
        return {
          success: false,
          error: `الكمية المتوفرة فالسطوك لـ "${prod.name}" غير كافية (${availableInStock.length} مسكانة متوفرة، و${pendingCount} فانتظار السكان). يرجى سكان القطع أولاً أو تقليل العدد.`
        };
      }
      plannedSelections.push({
        prod,
        unitsToDeduct: availableInStock.slice(0, qty),
        qty
      });
    }

    // Step 2: Build invoice + update units + log movements
    const nowIso = new Date().toISOString();
    const invSeq = String((this.data.clientStockInvoices?.length || 0) + 1).padStart(4, '0');
    const nowDate = new Date();
    const ym = `${String(nowDate.getFullYear()).slice(-2)}${String(nowDate.getMonth() + 1).padStart(2, '0')}`;
    const invoiceId = `stkinv-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`;
    const invoiceNumber = `FAC-STK-${ym}-${invSeq}`;

    const invoiceItems: ClientStockInvoiceItem[] = [];
    const createdMovements: ClientStockMovement[] = [];
    let productsValue = 0;
    let totalQuantity = 0;

    for (const sel of plannedSelections) {
      const codes = sel.unitsToDeduct.map(u => u.unitCode);
      for (const u of sel.unitsToDeduct) {
        u.status = 'expedie';
        u.packageId = payload.packageId;
        u.packageTrackingNumber = payload.trackingNumber;
        u.invoiceId = invoiceId;
        u.dispatchedAt = nowIso;
      }
      sel.prod.updatedAt = nowIso;

      const subtotal = Math.round(sel.prod.unitPrice * sel.qty * 100) / 100;
      productsValue += subtotal;
      totalQuantity += sel.qty;

      invoiceItems.push({
        productId: sel.prod.id,
        productName: sel.prod.name,
        photoUrl: sel.prod.photoUrl,
        skuCode: sel.prod.skuCode,
        quantity: sel.qty,
        unitPrice: sel.prod.unitPrice,
        unitCodes: codes,
        subtotal
      });

      const mv: ClientStockMovement = {
        id: `stkmov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        productId: sel.prod.id,
        productName: sel.prod.name,
        clientId: sel.prod.clientId,
        type: 'sortie_colis',
        quantity: sel.qty,
        unitCodes: codes,
        packageId: payload.packageId,
        packageTrackingNumber: payload.trackingNumber,
        invoiceId,
        actorName: payload.actorName || payload.clientCompany || payload.clientName,
        notes: `سحب تلقائي (${sel.qty} قطعة) للكوليا ${payload.trackingNumber} — فاتورة ${invoiceNumber}`,
        createdAt: nowIso
      };
      this.data.clientStockMovements!.unshift(mv);
      createdMovements.push(mv);
    }

    const deliveryFee = Math.max(0, Math.round((Number(payload.deliveryFee) || 0) * 100) / 100);
    const invoice: ClientStockInvoice = {
      id: invoiceId,
      invoiceNumber,
      clientId: plannedSelections[0]?.prod.clientId || cleanClientId,
      clientName: payload.clientName,
      clientCompany: payload.clientCompany,
      clientPhone: payload.clientPhone,
      packageId: payload.packageId,
      trackingNumber: payload.trackingNumber,
      recipientName: payload.recipientName,
      recipientCity: payload.recipientCity,
      items: invoiceItems,
      totalQuantity,
      productsValue: Math.round(productsValue * 100) / 100,
      deliveryFee,
      totalCodAmount: Math.round((productsValue + deliveryFee) * 100) / 100,
      status: 'generee',
      createdAt: nowIso
    };

    this.data.clientStockInvoices!.unshift(invoice);
    this.persist();

    return {
      success: true,
      invoice,
      updatedProducts: plannedSelections.map(s => s.prod),
      movements: createdMovements
    };
  }

  public dispatchClientStockUnit(
    codeOrProductId: string,
    opts?: {
      clientId?: string;
      trackingNumber?: string;
      packageId?: string;
      actorName?: string;
      notes?: string;
    }
  ): {
    success: boolean;
    message: string;
    product?: ClientStockProduct;
    unit?: ClientStockUnit;
    movement?: ClientStockMovement;
  } {
    this.ensureClientStockArrays();
    const clean = (codeOrProductId || '').trim().toUpperCase();
    if (!clean) {
      return { success: false, message: 'يرجى إدخال كود القطعة أو المنتوج.' };
    }

    const nowIso = new Date().toISOString();
    let targetProd: ClientStockProduct | undefined;
    let targetUnit: ClientStockUnit | undefined;

    for (const prod of this.data.clientStockProducts!) {
      if (opts?.clientId && prod.clientId !== opts.clientId) continue;
      const exactUnit = prod.units.find(u => u.unitCode.toUpperCase() === clean);
      if (exactUnit) {
        targetProd = prod;
        targetUnit = exactUnit;
        break;
      }
    }

    if (!targetProd) {
      const matchedProd = this.data.clientStockProducts!.find(
        p =>
          (!opts?.clientId || p.clientId === opts.clientId) &&
          (p.id.toUpperCase() === clean || p.skuCode.toUpperCase() === clean)
      );
      if (matchedProd) {
        targetProd = matchedProd;
        targetUnit = matchedProd.units.find(u => u.status === 'en_stock');
      }
    }

    if (!targetProd) {
      return { success: false, message: `الكود ${clean} غير موجود في سطوك الزبائن.` };
    }

    if (!targetUnit) {
      return {
        success: false,
        message: `لا توجد قطع متوفرة فالسطوك لـ "${targetProd.name}" لإخراجها حالياً.`,
        product: targetProd
      };
    }

    if (targetUnit.status === 'expedie') {
      return {
        success: false,
        message: `القطعة ${targetUnit.unitCode} (${targetProd.name}) تم إخراجها مسبقاً.`,
        product: targetProd,
        unit: targetUnit
      };
    }

    if (targetUnit.status === 'en_attente') {
      return {
        success: false,
        message: `القطعة ${targetUnit.unitCode} (${targetProd.name}) مازال فانتظار السكان، سْكانيها للسطوك أولاً قبل إخراجها.`,
        product: targetProd,
        unit: targetUnit
      };
    }

    targetUnit.status = 'expedie';
    targetUnit.dispatchedAt = nowIso;
    if (opts?.packageId) targetUnit.packageId = opts.packageId;
    if (opts?.trackingNumber) targetUnit.packageTrackingNumber = opts.trackingNumber;
    targetProd.updatedAt = nowIso;

    const mv: ClientStockMovement = {
      id: `stkmov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      productId: targetProd.id,
      productName: targetProd.name,
      clientId: targetProd.clientId,
      type: 'sortie_colis',
      quantity: 1,
      unitCodes: [targetUnit.unitCode],
      packageId: opts?.packageId,
      packageTrackingNumber: opts?.trackingNumber,
      actorName: opts?.actorName || 'Entrepôt',
      notes:
        opts?.notes ||
        `إخراج قطعة ${targetUnit.unitCode} من السطوك${opts?.trackingNumber ? ` (${opts.trackingNumber})` : ''}`,
      createdAt: nowIso
    };
    this.data.clientStockMovements!.unshift(mv);
    this.persist();

    const remaining = targetProd.units.filter(u => u.status === 'en_stock').length;
    return {
      success: true,
      message: `✅ تم إخراج القطعة ${targetUnit.unitCode} (${targetProd.name}) ونقصات من السطوك! المتبقي: ${remaining}`,
      product: targetProd,
      unit: targetUnit,
      movement: mv
    };
  }

  public restoreClientStockForPackage(
    packageId: string,
    trackingNumber?: string,
    actorName?: string
  ): { restoredCount: number; updatedProducts: ClientStockProduct[] } {
    this.ensureClientStockArrays();
    const cleanPkgId = (packageId || '').trim();
    const cleanTrk = (trackingNumber || '').trim().toUpperCase();
    if (!cleanPkgId && !cleanTrk) {
      return { restoredCount: 0, updatedProducts: [] };
    }

    const nowIso = new Date().toISOString();
    const updatedProducts: ClientStockProduct[] = [];
    let restoredCount = 0;

    for (const prod of this.data.clientStockProducts!) {
      const restoredCodes: string[] = [];
      for (const u of prod.units) {
        const matchesPkg =
          (cleanPkgId && u.packageId === cleanPkgId) ||
          (cleanTrk && u.packageTrackingNumber?.toUpperCase() === cleanTrk);
        if (matchesPkg && u.status === 'expedie') {
          u.status = 'en_stock';
          delete u.packageId;
          delete u.packageTrackingNumber;
          delete u.dispatchedAt;
          restoredCodes.push(u.unitCode);
        }
      }
      if (restoredCodes.length > 0) {
        prod.updatedAt = nowIso;
        updatedProducts.push(prod);
        restoredCount += restoredCodes.length;
        this.data.clientStockMovements!.unshift({
          id: `stkmov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          productId: prod.id,
          productName: prod.name,
          clientId: prod.clientId,
          type: 'scan_stock',
          quantity: restoredCodes.length,
          unitCodes: restoredCodes,
          actorName: actorName || 'Système',
          notes: `إرجاع ${restoredCodes.length} قطعة للسطوك بعد إلغاء/حذف الكوليا ${cleanTrk || cleanPkgId}`,
          createdAt: nowIso
        });
      }
    }

    if (restoredCount > 0) {
      this.persist();
    }
    return { restoredCount, updatedProducts };
  }

  public updateClientStockInvoiceStatus(id: string, status: 'generee' | 'payee'): ClientStockInvoice | null {
    this.ensureClientStockArrays();
    const inv = this.data.clientStockInvoices!.find(i => i.id === id);
    if (!inv) return null;
    inv.status = status;
    this.persist();
    return inv;
  }

  public deleteClientStockProduct(id: string): boolean {
    this.ensureClientStockArrays();
    const before = this.data.clientStockProducts!.length;
    this.data.clientStockProducts = this.data.clientStockProducts!.filter(p => p.id !== id);
    if (this.data.clientStockProducts!.length !== before) {
      this.data.clientStockMovements = this.data.clientStockMovements!.filter(m => m.productId !== id);
      this.persist();
      return true;
    }
    return false;
  }

  public deleteClientStockUnit(
    productId: string,
    unitIdOrCode: string
  ): { success: boolean; product?: ClientStockProduct; error?: string } {
    this.ensureClientStockArrays();
    const idx = this.data.clientStockProducts!.findIndex(p => p.id === productId);
    if (idx === -1) {
      return { success: false, error: 'المنتوج غير موجود.' };
    }
    const prod = this.data.clientStockProducts![idx];
    const cleanTarget = String(unitIdOrCode || '').trim().toUpperCase();
    const beforeLen = prod.units.length;
    prod.units = prod.units.filter(
      u => u.id !== unitIdOrCode && u.unitCode.toUpperCase() !== cleanTarget
    );
    if (prod.units.length === beforeLen) {
      return { success: false, error: 'القطعة غير موجودة في هذا المنتوج.' };
    }
    prod.updatedAt = new Date().toISOString();
    this.persist();
    return { success: true, product: prod };
  }

  // ---------------------------------------------------------------------------
  // SYSTEM COLLECTIONS (Cities, Agencies, Vehicles, Pickups, Bons, Payments, Debts, Stock Locations, Employees, Messages, Driver Requests, Partners)
  // ---------------------------------------------------------------------------
  private static readonly ALLOWED_COLLECTION_KEYS = new Set([
    'cities',
    'agencies',
    'vehicles',
    'partners',
    'partnerSyncLogs',
    'pickups',
    'payments',
    'clientDebts',
    'transferReceipts',
    'bons',
    'stockLocations',
    'employees',
    'savedAddresses',
    'clientCustomRates',
    'clientMessages',
    'driverRequests',
    'notifications',
    'auditLogs',
    'staffPresence',
    'staffShifts',
    'confirmationLogs',
    'customerBlacklist'
  ]);

  public getSystemCollections(): Record<string, any> {
    if (!this.data.systemCollections || typeof this.data.systemCollections !== 'object') {
      this.data.systemCollections = {};
    }
    return this.data.systemCollections;
  }

  public getSystemCollection<T = any>(key: string): T | undefined {
    const cols = this.getSystemCollections();
    return Object.prototype.hasOwnProperty.call(cols, key) ? (cols[key] as T) : undefined;
  }

  public setSystemCollection(key: string, value: any): boolean {
    if (!PersistentStorageService.ALLOWED_COLLECTION_KEYS.has(key)) {
      return false;
    }
    const cols = this.getSystemCollections();
    cols[key] = value;
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------------
  // STAFF PRESENCE, WORK SHIFTS (HOURS WORKED) & CONFIRMATION LOGS
  // ---------------------------------------------------------------------------
  public getStaffPresenceMap(): Record<string, StaffPresenceRecord> {
    const raw = this.getSystemCollection<Record<string, StaffPresenceRecord>>('staffPresence');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  }

  public getStaffShifts(): StaffWorkShift[] {
    const raw = this.getSystemCollection<StaffWorkShift[]>('staffShifts');
    return Array.isArray(raw) ? [...raw] : [];
  }

  public getConfirmationLogs(): ConfirmationActionLog[] {
    const raw = this.getSystemCollection<ConfirmationActionLog[]>('confirmationLogs');
    return Array.isArray(raw) ? [...raw] : [];
  }

  public addConfirmationLog(
    entry: Omit<ConfirmationActionLog, 'id' | 'timestamp'>
  ): ConfirmationActionLog {
    const logs = this.getConfirmationLogs();
    const record: ConfirmationActionLog = {
      ...entry,
      id: `conf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString()
    };
    const next = [record, ...logs].slice(0, 1500);
    this.setSystemCollection('confirmationLogs', next);
    return record;
  }

  public recordStaffHeartbeat(
    user: { id: string; name: string; email?: string; role: UserRole; employeeRole?: string },
    opts?: { currentPage?: string; offline?: boolean; actionLabel?: string; autoStartShiftForEmployee?: boolean }
  ): { presence: StaffPresenceRecord; activeShift: StaffWorkShift | null } {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const today = nowIso.slice(0, 10);

    const presenceMap = this.getStaffPresenceMap();
    const shifts = this.getStaffShifts();

    const prevPresence: StaffPresenceRecord = presenceMap[user.id] || {
      userId: user.id,
      userName: user.name,
      userEmail: user.email || '',
      role: user.role,
      employeeRole: user.employeeRole,
      lastSeenAt: nowIso,
      workStatus: 'off'
    };

    let activeShiftIdx = shifts.findIndex(
      s => s.userId === user.id && s.date === today && (s.status === 'active' || s.status === 'break')
    );

    if (opts?.autoStartShiftForEmployee && !opts?.offline && activeShiftIdx === -1 && user.role === 'employee') {
      const newShift: StaffWorkShift = {
        id: `shift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userId: user.id,
        userName: user.name,
        date: today,
        startedAt: nowIso,
        lastTickAt: nowIso,
        pausedSeconds: 0,
        workedSeconds: 0,
        status: 'active'
      };
      shifts.unshift(newShift);
      activeShiftIdx = 0;
    }

    let activeShift: StaffWorkShift | null = activeShiftIdx !== -1 ? { ...shifts[activeShiftIdx] } : null;

    if (activeShift) {
      if (activeShift.status === 'active') {
        const lastTickMs = new Date(activeShift.lastTickAt || activeShift.startedAt).getTime();
        const deltaSec = Math.max(0, Math.floor((nowMs - lastTickMs) / 1000));
        // Only count active online intervals up to 180s per heartbeat so offline/sleep time isn't inflated
        if (deltaSec > 0 && deltaSec <= 180) {
          activeShift.workedSeconds = (activeShift.workedSeconds || 0) + deltaSec;
        }
        activeShift.lastTickAt = nowIso;
      }
      if (opts?.offline && activeShift.status === 'active') {
        activeShift.status = 'break';
        activeShift.breakStartedAt = nowIso;
      }
      shifts[activeShiftIdx] = activeShift;
      this.setSystemCollection('staffShifts', shifts.slice(0, 500));
    }

    const updatedPresence: StaffPresenceRecord = {
      ...prevPresence,
      userId: user.id,
      userName: user.name,
      userEmail: user.email || prevPresence.userEmail || '',
      role: user.role,
      employeeRole: user.employeeRole || prevPresence.employeeRole,
      lastSeenAt: opts?.offline ? new Date(nowMs - 5 * 60 * 1000).toISOString() : nowIso,
      workStatus: opts?.offline
        ? activeShift?.status === 'break'
          ? 'break'
          : 'off'
        : activeShift
        ? activeShift.status === 'break'
          ? 'break'
          : 'working'
        : prevPresence.workStatus === 'working'
        ? 'off'
        : prevPresence.workStatus,
      currentShiftId: activeShift?.id,
      currentShiftStartedAt: activeShift?.startedAt,
      currentPage: opts?.currentPage !== undefined ? opts.currentPage : prevPresence.currentPage,
      lastActionAt: opts?.actionLabel ? nowIso : prevPresence.lastActionAt,
      lastActionLabel: opts?.actionLabel || prevPresence.lastActionLabel
    };

    presenceMap[user.id] = updatedPresence;
    this.setSystemCollection('staffPresence', presenceMap);

    return { presence: updatedPresence, activeShift };
  }

  public controlStaffShift(
    targetUser: { id: string; name: string; email?: string; role?: UserRole; employeeRole?: string },
    action: 'start' | 'pause' | 'resume' | 'end',
    actorName?: string,
    note?: string
  ): { shift: StaffWorkShift | null; presence: StaffPresenceRecord } {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const today = nowIso.slice(0, 10);

    const shifts = this.getStaffShifts();
    const presenceMap = this.getStaffPresenceMap();
    let idx = shifts.findIndex(
      s => s.userId === targetUser.id && s.date === today && (s.status === 'active' || s.status === 'break')
    );

    let shift: StaffWorkShift | null = idx !== -1 ? { ...shifts[idx] } : null;

    if (action === 'start') {
      if (!shift) {
        shift = {
          id: `shift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          userId: targetUser.id,
          userName: targetUser.name,
          date: today,
          startedAt: nowIso,
          lastTickAt: nowIso,
          pausedSeconds: 0,
          workedSeconds: 0,
          status: 'active',
          notes: note
        };
        shifts.unshift(shift);
      } else if (shift.status === 'break') {
        const breakStartMs = shift.breakStartedAt ? new Date(shift.breakStartedAt).getTime() : nowMs;
        shift.pausedSeconds = (shift.pausedSeconds || 0) + Math.max(0, Math.floor((nowMs - breakStartMs) / 1000));
        shift.breakStartedAt = undefined;
        shift.lastTickAt = nowIso;
        shift.status = 'active';
        shifts[idx] = shift;
      }
    } else if (action === 'pause' && shift && shift.status === 'active') {
      const lastTickMs = new Date(shift.lastTickAt || shift.startedAt).getTime();
      const deltaSec = Math.max(0, Math.floor((nowMs - lastTickMs) / 1000));
      if (deltaSec > 0 && deltaSec <= 180) {
        shift.workedSeconds = (shift.workedSeconds || 0) + deltaSec;
      }
      shift.lastTickAt = nowIso;
      shift.breakStartedAt = nowIso;
      shift.status = 'break';
      shifts[idx] = shift;
    } else if (action === 'resume' && shift && shift.status === 'break') {
      const breakStartMs = shift.breakStartedAt ? new Date(shift.breakStartedAt).getTime() : nowMs;
      shift.pausedSeconds = (shift.pausedSeconds || 0) + Math.max(0, Math.floor((nowMs - breakStartMs) / 1000));
      shift.breakStartedAt = undefined;
      shift.lastTickAt = nowIso;
      shift.status = 'active';
      shifts[idx] = shift;
    } else if (action === 'end' && shift) {
      if (shift.status === 'active') {
        const lastTickMs = new Date(shift.lastTickAt || shift.startedAt).getTime();
        const deltaSec = Math.max(0, Math.floor((nowMs - lastTickMs) / 1000));
        if (deltaSec > 0 && deltaSec <= 180) {
          shift.workedSeconds = (shift.workedSeconds || 0) + deltaSec;
        }
      } else if (shift.status === 'break' && shift.breakStartedAt) {
        const breakStartMs = new Date(shift.breakStartedAt).getTime();
        shift.pausedSeconds = (shift.pausedSeconds || 0) + Math.max(0, Math.floor((nowMs - breakStartMs) / 1000));
        shift.breakStartedAt = undefined;
      }
      shift.lastTickAt = nowIso;
      shift.endedAt = nowIso;
      shift.status = 'completed';
      shift.closedBy = actorName;
      if (note) shift.notes = note;
      shifts[idx] = shift;
    }

    this.setSystemCollection('staffShifts', shifts.slice(0, 500));

    const prev = presenceMap[targetUser.id];
    const updatedPresence: StaffPresenceRecord = {
      userId: targetUser.id,
      userName: targetUser.name,
      userEmail: targetUser.email || prev?.userEmail || '',
      role: targetUser.role || prev?.role || 'employee',
      employeeRole: targetUser.employeeRole || prev?.employeeRole,
      lastSeenAt: prev?.lastSeenAt || nowIso,
      workStatus: !shift || shift.status === 'completed' ? 'off' : shift.status === 'break' ? 'break' : 'working',
      currentShiftId: shift && shift.status !== 'completed' ? shift.id : undefined,
      currentShiftStartedAt: shift && shift.status !== 'completed' ? shift.startedAt : undefined,
      currentPage: prev?.currentPage,
      lastActionAt: nowIso,
      lastActionLabel:
        action === 'start'
          ? 'بداية حصة العمل'
          : action === 'pause'
          ? 'استراحة مؤقتة'
          : action === 'resume'
          ? 'استئناف العمل'
          : 'إنهاء حصة العمل'
    };

    presenceMap[targetUser.id] = updatedPresence;
    this.setSystemCollection('staffPresence', presenceMap);

    return { shift, presence: updatedPresence };
  }

  // ---------------------------------------------------------------------------
  // CUSTOMER BLACKLIST (اللائحة السوداء للزبناء المشتركة)
  // ---------------------------------------------------------------------------
  public getBlacklistEntries(): BlacklistEntry[] {
    const raw = this.getSystemCollection<BlacklistEntry[]>('customerBlacklist');
    if (!Array.isArray(raw)) return [];
    return [...raw].sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime()
    );
  }

  public checkBlacklistPhone(phone: string): {
    normalizedPhone: string;
    blacklisted: boolean;
    matches: BlacklistEntry[];
    reportCount: number;
    latestComment: string;
  } {
    const normalizedPhone = normalizeBlacklistPhone(phone);
    if (normalizedPhone.length < 8) {
      return {
        normalizedPhone,
        blacklisted: false,
        matches: [],
        reportCount: 0,
        latestComment: ''
      };
    }
    const matches = this.getBlacklistEntries().filter(
      e => (e.normalizedPhone || normalizeBlacklistPhone(e.phone)) === normalizedPhone
    );
    return {
      normalizedPhone,
      blacklisted: matches.length > 0,
      matches,
      reportCount: matches.length,
      latestComment: matches[0]?.comment || ''
    };
  }

  public addBlacklistEntry(payload: {
    phone: string;
    customerName?: string;
    city?: string;
    reason?: string;
    comment: string;
    reportedById: string;
    reportedByName: string;
    reportedByCompany?: string;
    reportedByRole: UserRole;
  }): { success: boolean; entry?: BlacklistEntry; error?: string } {
    const rawPhone = String(payload.phone || '').trim();
    const normalizedPhone = normalizeBlacklistPhone(rawPhone);
    if (normalizedPhone.length < 8) {
      return {
        success: false,
        error: 'رقم الهاتف غير صالح. يرجى إدخال رقم هاتف مغربي أو دولي صحيح.'
      };
    }

    const cleanComment = String(payload.comment || '').trim();
    if (cleanComment.length < 3) {
      return {
        success: false,
        error: 'يرجى كتابة تعليق أو سبب إدراج هذا الزبون في اللائحة السوداء.'
      };
    }

    const reason = String(payload.reason || '').trim() || 'كيلغي الطلبيات بزاف';
    const customerName = String(payload.customerName || '').trim() || undefined;
    const city = String(payload.city || '').trim() || undefined;
    const nowIso = new Date().toISOString();

    const list = this.getBlacklistEntries();
    const existingIdx = list.findIndex(
      e =>
        (e.normalizedPhone || normalizeBlacklistPhone(e.phone)) === normalizedPhone &&
        e.reportedById === payload.reportedById
    );

    let savedEntry: BlacklistEntry;
    if (existingIdx !== -1) {
      const existing = list[existingIdx];
      savedEntry = {
        ...existing,
        phone: rawPhone,
        normalizedPhone,
        customerName: customerName || existing.customerName,
        city: city || existing.city,
        reason,
        comment: cleanComment,
        reportedByName: payload.reportedByName || existing.reportedByName,
        reportedByCompany: payload.reportedByCompany || existing.reportedByCompany,
        updatedAt: nowIso
      };
      list[existingIdx] = savedEntry;
    } else {
      savedEntry = {
        id: `bl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        phone: rawPhone,
        normalizedPhone,
        customerName,
        city,
        reason,
        comment: cleanComment,
        reportedById: payload.reportedById,
        reportedByName: payload.reportedByName,
        reportedByCompany: payload.reportedByCompany,
        reportedByRole: payload.reportedByRole,
        createdAt: nowIso
      };
      list.unshift(savedEntry);
    }

    this.setSystemCollection('customerBlacklist', list.slice(0, 5000));
    return { success: true, entry: savedEntry };
  }

  public deleteBlacklistEntry(
    id: string,
    actorId: string,
    isAdminActor: boolean
  ): { success: boolean; error?: string } {
    const list = this.getBlacklistEntries();
    const target = list.find(e => e.id === id);
    if (!target) {
      return { success: false, error: 'السجل غير موجود في اللائحة السوداء.' };
    }
    if (!isAdminActor && target.reportedById !== actorId) {
      return {
        success: false,
        error: 'يمكنك فقط حذف البلاغات التي قمت بإضافتها.'
      };
    }
    const next = list.filter(e => e.id !== id);
    this.setSystemCollection('customerBlacklist', next);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // WHATSAPP DISPATCH LOGS
  // ---------------------------------------------------------------------------
  public getWhatsappLogs(): WhatsappDispatchLog[] {
    if (!Array.isArray(this.data.whatsappLogs)) {
      this.data.whatsappLogs = [];
    }
    return this.data.whatsappLogs;
  }

  public addWhatsappLog(log: WhatsappDispatchLog): WhatsappDispatchLog {
    if (!Array.isArray(this.data.whatsappLogs)) {
      this.data.whatsappLogs = [];
    }
    this.data.whatsappLogs.unshift(log);
    if (this.data.whatsappLogs.length > 100) {
      this.data.whatsappLogs = this.data.whatsappLogs.slice(0, 100);
    }
    this.persist();
    return log;
  }

  public clearWhatsappLogs(): void {
    this.data.whatsappLogs = [];
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // VISITOR BROWSER TELEMETRY
  // ---------------------------------------------------------------------------
  public classifyBrowser(userAgent: string = ''): 'chrome' | 'safari' | 'firefox' | 'edge' | 'other' {
    const ua = String(userAgent || '').toLowerCase();
    if (!ua) return 'other';
    if (ua.includes('edg/') || ua.includes('edga/') || ua.includes('edgios/') || ua.includes('edge/')) {
      return 'edge';
    }
    if (ua.includes('firefox/') || ua.includes('fxios/')) {
      return 'firefox';
    }
    if ((ua.includes('chrome/') || ua.includes('crios/') || ua.includes('chromium/')) && !ua.includes('opr/') && !ua.includes('opera/')) {
      return 'chrome';
    }
    if (ua.includes('safari/') && !ua.includes('chrome/') && !ua.includes('crios/') && !ua.includes('android')) {
      return 'safari';
    }
    if (ua.includes('safari/') && (ua.includes('iphone') || ua.includes('ipad') || ua.includes('macintosh'))) {
      return 'safari';
    }
    return 'other';
  }

  public getVisitorStats(): VisitorStatsRecord {
    const raw = this.data.visitorStats;
    return {
      chrome: Number(raw?.chrome || 0),
      safari: Number(raw?.safari || 0),
      firefox: Number(raw?.firefox || 0),
      edge: Number(raw?.edge || 0),
      other: Number(raw?.other || 0),
      updatedAt: raw?.updatedAt
    };
  }

  public recordVisitorBrowser(userAgent: string): { browser: string; stats: VisitorStatsRecord } {
    const current = this.getVisitorStats();
    const browser = this.classifyBrowser(userAgent);
    current[browser] = (current[browser] || 0) + 1;
    current.updatedAt = new Date().toISOString();
    this.data.visitorStats = current;
    this.persist();
    return { browser, stats: current };
  }

  // ---------------------------------------------------------------------------
  // FULL BACKUP & RESTORE (EXPORT / IMPORT JSON)
  // ---------------------------------------------------------------------------
  public exportFullBackup() {
    const { sessions: _omittedSessions, ...exportableData } = this.data;
    return {
      app: 'FARIOUSY_DELIVERY',
      version: '1.0',
      exportedAt: new Date().toISOString(),
      data: JSON.parse(JSON.stringify(exportableData))
    };
  }

  public restoreFullBackup(payload: any): {
    success: boolean;
    message: string;
    stats?: {
      users: number;
      packages: number;
      shops: number;
      clientStockProducts: number;
      collectionsCount: number;
    };
  } {
    const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      return { success: false, message: 'Format de sauvegarde JSON invalide.' };
    }

    const hasKnownKey =
      Array.isArray(root.users) ||
      Array.isArray(root.packages) ||
      Array.isArray(root.shops) ||
      (root.systemCollections && typeof root.systemCollections === 'object') ||
      (root.companySettings && typeof root.companySettings === 'object');

    if (!hasKnownKey) {
      return {
        success: false,
        message: 'Le fichier JSON ne contient aucune donnée FARIOUSY valide (colis, utilisateurs ou paramètres).'
      };
    }

    const preservedSessions = this.data.sessions || {};
    const incomingUsers: StoredUser[] = Array.isArray(root.users) ? root.users : this.data.users || [];

    // Ensure super_admin account is always present so administrator cannot lose access
    const hasSuperAdmin = incomingUsers.some(
      u => u.email?.toLowerCase() === INITIAL_ADMIN.email.toLowerCase() || u.role === 'super_admin'
    );
    const restoredUsers = hasSuperAdmin ? [...incomingUsers] : [INITIAL_ADMIN, ...incomingUsers];

    const restoredCols =
      root.systemCollections && typeof root.systemCollections === 'object'
        ? Object.fromEntries(
            Object.entries(root.systemCollections).filter(([k]) =>
              PersistentStorageService.ALLOWED_COLLECTION_KEYS.has(k)
            )
          )
        : {};

    this.data = {
      users: restoredUsers,
      shops: Array.isArray(root.shops) ? root.shops : [],
      packages: Array.isArray(root.packages) ? root.packages : [],
      auditLogs: Array.isArray(root.auditLogs) ? root.auditLogs : [],
      problemReports:
        root.problemReports && typeof root.problemReports === 'object' ? root.problemReports : {},
      packageOptions:
        root.packageOptions && typeof root.packageOptions === 'object' ? root.packageOptions : {},
      packageOverrides:
        root.packageOverrides && typeof root.packageOverrides === 'object' ? root.packageOverrides : {},
      kycDocuments:
        root.kycDocuments && typeof root.kycDocuments === 'object' ? root.kycDocuments : {},
      driverMeta:
        root.driverMeta && typeof root.driverMeta === 'object' ? root.driverMeta : {},
      partnerSecrets:
        root.partnerSecrets && typeof root.partnerSecrets === 'object' ? root.partnerSecrets : {},
      userSavedAddresses:
        root.userSavedAddresses && typeof root.userSavedAddresses === 'object' ? root.userSavedAddresses : {},
      companySettings:
        root.companySettings && typeof root.companySettings === 'object'
          ? root.companySettings
          : this.data.companySettings,
      securitySettings:
        root.securitySettings && typeof root.securitySettings === 'object'
          ? root.securitySettings
          : this.data.securitySettings,
      reviews: Array.isArray(root.reviews) ? root.reviews : [],
      clientStockProducts: Array.isArray(root.clientStockProducts) ? root.clientStockProducts : [],
      clientStockMovements: Array.isArray(root.clientStockMovements) ? root.clientStockMovements : [],
      clientStockInvoices: Array.isArray(root.clientStockInvoices) ? root.clientStockInvoices : [],
      systemCollections: restoredCols,
      whatsappLogs: Array.isArray(root.whatsappLogs) ? root.whatsappLogs.slice(0, 100) : [],
      visitorStats:
        root.visitorStats && typeof root.visitorStats === 'object'
          ? {
              chrome: Number(root.visitorStats.chrome || 0),
              safari: Number(root.visitorStats.safari || 0),
              firefox: Number(root.visitorStats.firefox || 0),
              edge: Number(root.visitorStats.edge || 0),
              other: Number(root.visitorStats.other || 0),
              updatedAt: root.visitorStats.updatedAt
            }
          : this.getVisitorStats(),
      sessions: preservedSessions
    };

    this.persist();

    return {
      success: true,
      message: 'Sauvegarde restaurée avec succès.',
      stats: {
        users: this.data.users.length,
        packages: this.data.packages.length,
        shops: this.data.shops.length,
        clientStockProducts: this.data.clientStockProducts?.length || 0,
        collectionsCount: Object.keys(restoredCols).length
      }
    };
  }

  // ---------------------------------------------------------------------------
  // SYSTEM WIPE & FULL RESET (SUPER ADMIN ONLY)
  // ---------------------------------------------------------------------------
  public wipeAllData(preserveSuperAdmin: boolean = true) {
    let superAdmin = this.data.users.find(
      u => u.email.toLowerCase() === INITIAL_ADMIN.email.toLowerCase()
    );
    if (!superAdmin) {
      superAdmin = { ...INITIAL_ADMIN, role: 'super_admin' };
    } else {
      superAdmin.role = 'super_admin';
      superAdmin.status = 'active';
      superAdmin.accountStatus = 'approuve';
    }

    const preservedCompanySettings = this.data.companySettings;
    const preservedSecuritySettings = this.data.securitySettings;
    const preservedSessions = this.data.sessions || {};
    const existingCols = this.getSystemCollections();

    this.data = {
      users: preserveSuperAdmin ? [superAdmin] : [],
      shops: [],
      packages: [],
      auditLogs: [],
      problemReports: {},
      packageOptions: {},
      packageOverrides: {},
      kycDocuments: {},
      driverMeta: {},
      partnerSecrets: {},
      userSavedAddresses: {},
      reviews: [],
      clientStockProducts: [],
      clientStockMovements: [],
      clientStockInvoices: [],
      whatsappLogs: [],
      visitorStats: { chrome: 0, safari: 0, firefox: 0, edge: 0, other: 0, updatedAt: new Date().toISOString() },
      systemCollections: {
        ...(existingCols.cities !== undefined ? { cities: existingCols.cities } : {}),
        ...(existingCols.agencies !== undefined ? { agencies: existingCols.agencies } : {}),
        vehicles: [],
        partners: [],
        partnerSyncLogs: [],
        pickups: [],
        payments: [],
        clientDebts: [],
        transferReceipts: [],
        bons: [],
        stockLocations: [],
        employees: [],
        savedAddresses: [],
        clientCustomRates: {},
        clientMessages: [],
        driverRequests: [],
        notifications: [],
        auditLogs: [],
        staffPresence: {},
        staffShifts: [],
        confirmationLogs: [],
        customerBlacklist: []
      },
      companySettings: preservedCompanySettings,
      securitySettings: preservedSecuritySettings,
      sessions: preservedSessions
    };
    this.persist();
    return { success: true, message: 'Le système a été entièrement vidé et réinitialisé avec succès.' };
  }
}

export const persistentStorage = new PersistentStorageService();
