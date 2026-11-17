import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useDatabase } from '../context/DatabaseContext';
import { useLanguage } from '../i18n/LanguageContext';
import {
  FacebookIcon,
  InstagramIcon,
  DEFAULT_FACEBOOK_URL,
  DEFAULT_INSTAGRAM_URL
} from './common/SocialIcons';
import {
  LayoutDashboard,
  Package,
  Users,
  Truck,
  Handshake,
  MapPin,
  BadgeDollarSign,
  CalendarCheck,
  Warehouse,
  Scan,
  CornerDownLeft,
  User,
  ShieldCheck,
  Building,
  CheckCircle2,
  PlusCircle,
  Search,
  Tag,
  UserCheck,
  LogOut,
  Briefcase,
  FileImage,
  Settings,
  Network,
  MessageSquare,
  FileText,
  Send,
  ChevronDown,
  X,
  Code2,
  Car,
  Star,
  Boxes,
  RefreshCw,
  Clock,
  Key,
  Wallet,
  Headset,
  ShieldAlert
} from 'lucide-react';

export type ActiveTab =
  | 'admin_dashboard'
  | 'admin_confirmation'
  | 'admin_packages'
  | 'admin_bons'
  | 'admin_clients'
  | 'admin_approvals'
  | 'admin_drivers'
  | 'admin_driver_approvals'
  | 'admin_vehicles'
  | 'admin_vehicle_add'
  | 'admin_employees'
  | 'admin_partners'
  | 'admin_partner_dispatch'
  | 'admin_api_partners'
  | 'admin_cities'
  | 'admin_hubs'
  | 'admin_finance'
  | 'admin_debts'
  | 'admin_pickups'
  | 'admin_stock'
  | 'admin_messages'
  | 'admin_reviews'
  | 'admin_blacklist'
  | 'admin_settings'
  | 'client_dashboard'
  | 'client_packages'
  | 'client_stock'
  | 'client_bons'
  | 'client_tracking'
  | 'client_pickups'
  | 'client_finance'
  | 'client_debts'
  | 'client_returns'
  | 'client_tariffs'
  | 'client_messages'
  | 'client_reviews'
  | 'client_blacklist'
  | 'client_profile'
  | 'driver_tour'
  | 'driver_cash'
  | 'partner_dashboard'
  | 'partner_packages'
  | 'partner_relances'
  | 'partner_returns'
  | 'partner_payments'
  | 'partner_receipts'
  | 'partner_api';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  onOpenScanner: () => void;
  onOpenAddPackage?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  isOpenMobile,
  onCloseMobile,
  onOpenScanner,
  onOpenAddPackage
}) => {
  const { currentRole, isAdmin, isClient, isDriver, isEmployee, currentUser, logout } = useAuth();
  const { packages, pickups, users, clientMessages, reviews, driverRequests, bons, agencies, vehicles, transferReceipts, payments, partners, clientStockProducts, companySettings, blacklistEntries } = useDatabase();
  const { t, isRtl, language } = useLanguage();
  const facebookUrl = companySettings?.facebookUrl?.trim() || DEFAULT_FACEBOOK_URL;
  const instagramUrl = companySettings?.instagramUrl?.trim() || DEFAULT_INSTAGRAM_URL;

  const pendingPickups = pickups.filter(p => p.status === 'en_attente').length;
  const waitingConfirmationCount = packages.filter(
    p =>
      p.confirmationStatus !== 'confirme' &&
      p.confirmationStatus !== 'annule' &&
      ['nouveau', 'attente_ramassage', 'pas_de_reponse', 'reporte'].includes(p.status)
  ).length;
  const problemPackagesCount = packages.filter(
    p => p.status === 'probleme_livraison' || (p.problemReport && !p.problemReport.resolved)
  ).length;
  const pendingClients = users.filter(
    u => u.role === 'client' && (u.status === 'pending' || u.status === 'en_attente')
  ).length;
  const pendingDriverRequests = driverRequests.filter(r => r.status === 'en_attente').length;
  const totalTransferReceiptsCount =
    transferReceipts.length + payments.filter(p => Boolean(p.receiptImageUrl)).length;
  const myTransferReceiptsCount =
    transferReceipts.filter(r => r.clientId === currentUser?.id).length +
    payments.filter(p => p.clientId === currentUser?.id && Boolean(p.receiptImageUrl)).length;
  const clientsCount = users.filter(u => u.role === 'client').length;
  const driversCount = users.filter(u => u.role === 'driver').length;

  const pendingAdminMessages = clientMessages.filter(m => m.status === 'nouveau').length;
  const myClientMessages = clientMessages.filter(m => m.clientId === currentUser?.id);
  const clientActiveMessages = myClientMessages.filter(m => m.status === 'nouveau' || m.status === 'en_cours').length;

  // Partner-specific live counters
  const matchedPartner = currentRole === 'partner'
    ? partners.find(
        p =>
          p.id === currentUser?.id ||
          (currentUser?.email && p.email && p.email.toLowerCase() === currentUser.email.toLowerCase()) ||
          (currentUser?.companyName && p.name.toLowerCase() === currentUser.companyName.toLowerCase())
      )
    : undefined;
  const partnerParcels = currentRole === 'partner'
    ? packages.filter(
        pkg =>
          pkg.partnerId === (matchedPartner?.id || currentUser?.id) ||
          (matchedPartner?.name && pkg.destinationAgency === matchedPartner.name) ||
          (matchedPartner?.city && pkg.destinationAgency === `Agence ${matchedPartner.city}`)
      )
    : [];
  const partnerRelancesCount = partnerParcels.filter(pkg =>
    ['pas_de_reponse', 'reporte', 'probleme_livraison'].includes(pkg.status)
  ).length;
  const partnerReturnsCount = partnerParcels.filter(pkg =>
    ['retour_en_cours', 'retourne', 'refuse', 'annule'].includes(pkg.status)
  ).length;

  const [openAdminGroup, setOpenAdminGroup] = React.useState<string | null>(() => {
    if (['admin_packages', 'admin_bons', 'admin_pickups', 'admin_stock'].includes(activeTab)) return 'logistics';
    if (['admin_clients', 'admin_approvals', 'admin_messages', 'admin_reviews'].includes(activeTab)) return 'clients';
    if (['admin_drivers', 'admin_driver_approvals', 'admin_vehicles', 'admin_vehicle_add'].includes(activeTab)) return 'fleet';
    if (['admin_partners', 'admin_partner_dispatch', 'admin_api_partners'].includes(activeTab)) return 'partners';
    if (['admin_finance', 'admin_debts'].includes(activeTab)) return 'finance';
    if (['admin_cities', 'admin_hubs', 'admin_employees', 'admin_settings'].includes(activeTab)) return 'network';
    return null;
  });

  React.useEffect(() => {
    if (['admin_packages', 'admin_bons', 'admin_pickups', 'admin_stock'].includes(activeTab)) setOpenAdminGroup('logistics');
    else if (['admin_clients', 'admin_approvals', 'admin_messages', 'admin_reviews'].includes(activeTab)) setOpenAdminGroup('clients');
    else if (['admin_drivers', 'admin_driver_approvals', 'admin_vehicles', 'admin_vehicle_add'].includes(activeTab)) setOpenAdminGroup('fleet');
    else if (['admin_partners', 'admin_partner_dispatch', 'admin_api_partners'].includes(activeTab)) setOpenAdminGroup('partners');
    else if (['admin_finance', 'admin_debts'].includes(activeTab)) setOpenAdminGroup('finance');
    else if (['admin_cities', 'admin_hubs', 'admin_employees', 'admin_settings'].includes(activeTab)) setOpenAdminGroup('network');
  }, [activeTab]);

  const toggleAdminGroup = (groupKey: string) => {
    setOpenAdminGroup(prev => (prev === groupKey ? null : groupKey));
  };

  const handleTabClick = (tab: ActiveTab) => {
    onSelectTab(tab);
    onCloseMobile();
  };

  const handleLogout = async () => {
    try {
      await logout();
      onCloseMobile();
    } catch (e) {
      console.warn('Logout notice:', e);
    }
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden backdrop-blur-2xs"
          onClick={onCloseMobile}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed md:sticky top-0 ${isRtl ? 'right-0' : 'left-0'} z-50 md:z-30 h-screen w-64 bg-slate-900 text-slate-300 flex flex-col justify-between transition-transform duration-200 ease-in-out md:translate-x-0 ${
          isOpenMobile ? 'translate-x-0' : isRtl ? 'translate-x-full' : '-translate-x-full'
        }`}
      >
        {/* Top Branding & Scrollable Navigation Section */}
        <div className="flex-1 overflow-y-auto flex flex-col">
          <div className="p-4 sm:p-5 border-b border-slate-800/80 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <img
                src="/assets/aistudio/WhatsApp_Image_2026-10-25_at_01.07.07_dafc315a.jpeg"
                alt="Logo FARIOUSY"
                className="w-10 h-10 object-contain rounded-full bg-white p-0.5 shrink-0"
              />
              <div>
                <span className="font-black text-white tracking-wider text-base block leading-none">
                  FARIOUSY
                </span>
                <span className="text-[10px] font-bold text-red-500 tracking-widest block uppercase">
                  Fast Delivery
                </span>
              </div>
            </div>
            {/* Mobile Close Button */}
            <button
              onClick={onCloseMobile}
              className="md:hidden p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="Fermer le menu"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* User Role Banner */}
          <div className="px-4 py-3 mx-3 my-3 rounded-xl bg-slate-800/60 border border-slate-800 flex items-center justify-between shrink-0">
            <div className="truncate">
              <span className="text-[10px] text-slate-400 uppercase font-semibold tracking-wider block">
                {isAdmin
                  ? t('sidebar.companyAdmin')
                  : isEmployee
                  ? t('sidebar.agency')
                  : isDriver
                  ? t('sidebar.driverSpace')
                  : currentRole === 'partner'
                  ? t('sidebar.partnerSpace')
                  : t('sidebar.clientSpace')}
              </span>
              <span className="text-xs font-bold text-white truncate block">
                {currentUser?.companyName || currentUser?.name}
              </span>
            </div>
            {isAdmin && <ShieldCheck className="w-4 h-4 text-red-500 shrink-0" />}
            {isClient && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
            {isDriver && <Truck className="w-4 h-4 text-amber-500 shrink-0" />}
          </div>

          {/* Navigation Links based on role (pushed down cleanly when compact) */}
          <nav className={`px-3 pb-4 space-y-1.5 text-xs ${(isAdmin || isEmployee) ? 'mt-auto pt-6' : ''}`}>
            {/* ADMIN / EMPLOYEE MENU — Grouped by Domain */}
            {(isAdmin || isEmployee) && (
              <>
                <div className="px-3 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {t('sidebar.sectionAdmin')}
                </div>

                {/* 1. Tableau de bord */}
                <button
                  onClick={() => handleTabClick('admin_dashboard')}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl font-semibold transition-all ${isRtl ? 'text-right' : 'text-left'} cursor-pointer ${
                    activeTab === 'admin_dashboard'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <LayoutDashboard className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.dashboard')}</span>
                </button>

                {/* 1b. Confirmation Center (مركز التأكيد) */}
                <button
                  onClick={() => handleTabClick('admin_confirmation')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all ${isRtl ? 'text-right' : 'text-left'} cursor-pointer ${
                    activeTab === 'admin_confirmation'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Headset className="w-4 h-4 shrink-0 text-emerald-400" />
                    <span>{t('sidebar.confirmationCenter', 'مركز التأكيد')}</span>
                  </span>
                  {waitingConfirmationCount > 0 && (
                    <span className="font-mono text-[10px] bg-emerald-500 text-slate-950 px-1.5 py-0.5 rounded-full font-bold force-ltr">
                      {waitingConfirmationCount}
                    </span>
                  )}
                </button>

                {/* 1c. Contrôle & Performance des Employés (للمدير) */}
                {isAdmin && (
                  <button
                    onClick={() => handleTabClick('admin_employees')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all ${isRtl ? 'text-right' : 'text-left'} cursor-pointer ${
                      activeTab === 'admin_employees'
                        ? 'bg-red-600 text-white font-bold shadow-xs'
                        : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Briefcase className="w-4 h-4 shrink-0 text-amber-400" />
                      <span>{t('sidebar.employeesControl', 'مراقبة العمال والأداء')}</span>
                    </span>
                  </button>
                )}

                {/* 1d. Customer Blacklist (اللائحة السوداء للزبناء) */}
                <button
                  onClick={() => handleTabClick('admin_blacklist')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all ${isRtl ? 'text-right' : 'text-left'} cursor-pointer ${
                    activeTab === 'admin_blacklist'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400" />
                    <span>{t('sidebar.blacklist', 'اللائحة السوداء (Blacklist)')}</span>
                  </span>
                  {blacklistEntries.length > 0 && (
                    <span className="font-mono text-[10px] bg-rose-600 text-white px-1.5 py-0.5 rounded-full font-bold force-ltr">
                      {blacklistEntries.length}
                    </span>
                  )}
                </button>

                {/* 2. Groupe: Colis & Logistique */}
                <div className="space-y-0.5">
                  <button
                    onClick={() => toggleAdminGroup('logistics')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all ${isRtl ? 'text-right' : 'text-left'} cursor-pointer ${
                      ['admin_packages', 'admin_bons', 'admin_pickups', 'admin_stock'].includes(activeTab)
                        ? 'bg-red-600 text-white font-bold shadow-xs'
                        : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Package className="w-4 h-4 shrink-0" />
                      <span>{t('sidebar.logisticsGroup')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {(problemPackagesCount > 0 || pendingPickups > 0) && (
                        <span className="font-mono text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full font-bold force-ltr">
                          {problemPackagesCount + pendingPickups}
                        </span>
                      )}
                      <ChevronDown
                        className={`w-3.5 h-3.5 text-slate-300 transition-transform ${
                          openAdminGroup === 'logistics' ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>

                  {openAdminGroup === 'logistics' && (
                    <div className={`py-1 space-y-1 border-red-500/50 my-1 ${isRtl ? 'pr-5 pl-2 border-r-2 mr-4' : 'pl-5 pr-2 border-l-2 ml-4'}`}>
                      <button
                        onClick={() => handleTabClick('admin_packages')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_packages'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Package className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.packages')}</span>
                        </span>
                        <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                          {packages.length}
                        </span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_bons')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_bons'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <FileText className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                          <span>{t('sidebar.bons', 'البونات (Bons)')}</span>
                        </span>
                        <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                          {bons.length}
                        </span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_pickups')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_pickups'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <CalendarCheck className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.pickups')}</span>
                        </span>
                        {pendingPickups > 0 && (
                          <span className="font-bold text-[9px] bg-red-500 text-white px-1.5 rounded-full force-ltr">
                            {pendingPickups}
                          </span>
                        )}
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_stock')}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_stock'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <Warehouse className="w-3.5 h-3.5 shrink-0" />
                        <span>{t('sidebar.stock')}</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* 3. Groupe: Clients & Support */}
                <div className="space-y-0.5">
                  <button
                    onClick={() => toggleAdminGroup('clients')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all text-left cursor-pointer ${
                      ['admin_clients', 'admin_approvals', 'admin_messages', 'admin_reviews'].includes(activeTab)
                        ? 'bg-red-600 text-white font-bold shadow-xs'
                        : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Users className="w-4 h-4 shrink-0" />
                      <span>{t('sidebar.clientsGroup')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {(pendingClients > 0 || pendingAdminMessages > 0) && (
                        <span className="font-bold text-[10px] bg-amber-500 text-slate-950 px-1.5 rounded-full force-ltr">
                          {pendingClients + pendingAdminMessages}
                        </span>
                      )}
                      <ChevronDown
                        className={`w-3.5 h-3.5 text-slate-300 transition-transform ${
                          openAdminGroup === 'clients' ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>

                  {openAdminGroup === 'clients' && (
                    <div className={`py-1 space-y-1 border-red-500/50 my-1 ${isRtl ? 'pr-5 pl-2 border-r-2 mr-4' : 'pl-5 pr-2 border-l-2 ml-4'}`}>
                      <button
                        onClick={() => handleTabClick('admin_clients')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_clients'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Users className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.clientsList')}</span>
                        </span>
                        {clientsCount > 0 && (
                          <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                            {clientsCount}
                          </span>
                        )}
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_approvals')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_approvals'
                            ? 'bg-amber-600 text-white font-bold'
                            : 'text-amber-300 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <UserCheck className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.newClientsValidation')}</span>
                        </span>
                        {pendingClients > 0 && (
                          <span className="font-bold text-[9px] bg-amber-500 text-slate-950 px-1.5 rounded-full force-ltr">
                            {pendingClients}
                          </span>
                        )}
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_messages')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_messages'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                          <span>{t('sidebar.clientMessages', 'Messages Clients')}</span>
                        </span>
                        {pendingAdminMessages > 0 && (
                          <span className="font-bold text-[9px] bg-red-600 text-white px-1.5 rounded-full force-ltr">
                            {pendingAdminMessages}
                          </span>
                        )}
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_reviews')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_reviews'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Star className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                          <span>{language === 'ar' ? 'آراء الزبائن والليفرورز' : 'Avis & Évaluations'}</span>
                        </span>
                        {reviews.length > 0 && (
                          <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                            {reviews.length}
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* 4. Groupe: Livreurs & Flotte */}
                <div className="space-y-0.5">
                  <button
                    onClick={() => toggleAdminGroup('fleet')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all text-left cursor-pointer ${
                      ['admin_drivers', 'admin_driver_approvals', 'admin_vehicles', 'admin_vehicle_add'].includes(activeTab)
                        ? 'bg-red-600 text-white font-bold shadow-xs'
                        : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Truck className="w-4 h-4 shrink-0" />
                      <span>{t('sidebar.fleetGroup')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {pendingDriverRequests > 0 && (
                        <span className="font-bold text-[10px] bg-amber-500 text-slate-950 px-1.5 rounded-full animate-pulse force-ltr">
                          {pendingDriverRequests}
                        </span>
                      )}
                      <ChevronDown
                        className={`w-3.5 h-3.5 text-slate-300 transition-transform ${
                          openAdminGroup === 'fleet' ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>

                  {openAdminGroup === 'fleet' && (
                    <div className={`py-1 space-y-1 border-red-500/50 my-1 ${isRtl ? 'pr-5 pl-2 border-r-2 mr-4' : 'pl-5 pr-2 border-l-2 ml-4'}`}>
                      <button
                        onClick={() => handleTabClick('admin_drivers')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_drivers'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Truck className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.drivers')}</span>
                        </span>
                        {driversCount > 0 && (
                          <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                            {driversCount}
                          </span>
                        )}
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_driver_approvals')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_driver_approvals'
                            ? 'bg-amber-600 text-white font-bold'
                            : 'text-amber-300 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <UserCheck className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.newDriversValidation', 'Demandes Livreurs')}</span>
                        </span>
                        {pendingDriverRequests > 0 && (
                          <span className="font-bold text-[9px] bg-amber-500 text-slate-950 px-1.5 rounded-full force-ltr">
                            {pendingDriverRequests}
                          </span>
                        )}
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_vehicles')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_vehicles'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Car className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.allVehicles')}</span>
                        </span>
                        <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                          {vehicles.length}
                        </span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_vehicle_add')}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_vehicle_add'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <PlusCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>{t('sidebar.addVehicle')}</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* 5. Groupe: Partenaires & API */}
                <div className="space-y-0.5">
                  <button
                    onClick={() => toggleAdminGroup('partners')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all text-left cursor-pointer ${
                      ['admin_partners', 'admin_partner_dispatch', 'admin_api_partners'].includes(activeTab)
                        ? 'bg-red-600 text-white font-bold shadow-xs'
                        : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Handshake className="w-4 h-4 shrink-0" />
                      <span>{t('sidebar.partnersGroup')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {partners.length > 0 && (
                        <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                          {partners.length}
                        </span>
                      )}
                      <ChevronDown
                        className={`w-3.5 h-3.5 text-slate-300 transition-transform ${
                          openAdminGroup === 'partners' ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>

                  {openAdminGroup === 'partners' && (
                    <div className={`py-1 space-y-1 border-red-500/50 my-1 ${isRtl ? 'pr-5 pl-2 border-r-2 mr-4' : 'pl-5 pr-2 border-l-2 ml-4'}`}>
                      <button
                        onClick={() => handleTabClick('admin_partners')}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_partners'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <Handshake className="w-3.5 h-3.5 shrink-0" />
                        <span>{t('sidebar.partners')}</span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_partner_dispatch')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_partner_dispatch'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Send className="w-3.5 h-3.5 shrink-0 text-red-400" />
                          <span>{t('sidebar.sendToPartner')}</span>
                        </span>
                        <span className="text-[10px] font-bold text-red-300 bg-red-950/60 px-1.5 py-0.5 rounded">
                          {t('sidebar.partnerBindBadge')}
                        </span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_api_partners')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_api_partners'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Network className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                          <span>{t('sidebar.apiPartners')}</span>
                        </span>
                        <span className="font-mono text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full font-bold">
                          REST
                        </span>
                      </button>
                    </div>
                  )}
                </div>

                {/* 6. Groupe: Finance & Dettes */}
                <div className="space-y-0.5">
                  <button
                    onClick={() => toggleAdminGroup('finance')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all text-left cursor-pointer ${
                      ['admin_finance', 'admin_debts'].includes(activeTab)
                        ? 'bg-red-600 text-white font-bold shadow-xs'
                        : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <BadgeDollarSign className="w-4 h-4 shrink-0" />
                      <span>{t('sidebar.financeGroup')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {totalTransferReceiptsCount > 0 && (
                        <span className="font-mono text-[10px] bg-emerald-500 text-white px-1.5 rounded-full font-bold force-ltr">
                          {totalTransferReceiptsCount}
                        </span>
                      )}
                      <ChevronDown
                        className={`w-3.5 h-3.5 text-slate-300 transition-transform ${
                          openAdminGroup === 'finance' ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>

                  {openAdminGroup === 'finance' && (
                    <div className={`py-1 space-y-1 border-red-500/50 my-1 ${isRtl ? 'pr-5 pl-2 border-r-2 mr-4' : 'pl-5 pr-2 border-l-2 ml-4'}`}>
                      <button
                        onClick={() => handleTabClick('admin_finance')}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_finance'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <BadgeDollarSign className="w-3.5 h-3.5 shrink-0" />
                        <span>{t('sidebar.finance')}</span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_debts')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_debts'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <FileImage className="w-3.5 h-3.5 shrink-0" />
                          <span>{t('sidebar.debts')}</span>
                        </span>
                        {totalTransferReceiptsCount > 0 && (
                          <span className="font-mono text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.2 rounded font-bold force-ltr">
                            {totalTransferReceiptsCount}
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* 7. Groupe: Réseau & Paramètres */}
                <div className="space-y-0.5">
                  <button
                    onClick={() => toggleAdminGroup('network')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-semibold transition-all text-left cursor-pointer ${
                      ['admin_cities', 'admin_hubs', 'admin_employees', 'admin_settings'].includes(activeTab)
                        ? 'bg-red-600 text-white font-bold shadow-xs'
                        : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Settings className="w-4 h-4 shrink-0 text-red-400" />
                      <span>{t('sidebar.networkGroup')}</span>
                    </div>
                    <ChevronDown
                      className={`w-3.5 h-3.5 text-slate-300 transition-transform ${
                        openAdminGroup === 'network' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  {openAdminGroup === 'network' && (
                    <div className={`py-1 space-y-1 border-red-500/50 my-1 ${isRtl ? 'pr-5 pl-2 border-r-2 mr-4' : 'pl-5 pr-2 border-l-2 ml-4'}`}>
                      <button
                        onClick={() => handleTabClick('admin_cities')}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_cities'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <span>{t('sidebar.citiesTariffs')}</span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_hubs')}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_hubs'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Building className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                          <span>{t('sidebar.hubs')}</span>
                        </span>
                        <span className="text-[10px] font-bold text-amber-300 bg-amber-950/60 px-1.5 py-0.5 rounded force-ltr">
                          {agencies.length}
                        </span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_employees')}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_employees'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <Briefcase className="w-3.5 h-3.5 shrink-0" />
                        <span>{t('sidebar.employees')}</span>
                      </button>

                      <button
                        onClick={() => handleTabClick('admin_settings')}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                          activeTab === 'admin_settings'
                            ? 'bg-red-700 text-white font-bold'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        <Settings className="w-3.5 h-3.5 shrink-0 text-red-400" />
                        <span>{t('sidebar.settings')}</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* CLIENT MENU */}
            {isClient && (
              <>
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {t('sidebar.sectionClient')}
                </div>

                {/* 1. Tableau de bord */}
                <button
                  onClick={() => handleTabClick('client_dashboard')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_dashboard'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <LayoutDashboard className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.clientDashboard')}</span>
                </button>

                {/* 2. Ajouter un colis */}
                <button
                  onClick={() => {
                    onCloseMobile();
                    if (onOpenAddPackage) onOpenAddPackage();
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left bg-red-950/40 text-red-400 hover:bg-red-900/60 hover:text-white border border-red-900/40"
                >
                  <PlusCircle className="w-4 h-4 shrink-0 text-red-500" />
                  <span>{t('sidebar.clientAddPackage')}</span>
                </button>

                {/* 3. Liste de mes colis */}
                <button
                  onClick={() => handleTabClick('client_packages')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_packages'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Package className="w-4 h-4 shrink-0" />
                    <span>{t('sidebar.clientPackages')}</span>
                  </div>
                  <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                    {packages.filter(p => {
                      const sId = (currentUser as any)?.shopId;
                      return (
                        p.clientId === currentUser?.id ||
                        (Boolean(p.shopId) && (p.shopId === currentUser?.id || (Boolean(sId) && p.shopId === sId))) ||
                        (Boolean(sId) && p.clientId === sId)
                      );
                    }).length}
                  </span>
                </button>

                {/* 3b. السطوك ديالي (Stock & Codes-barres) */}
                <button
                  onClick={() => handleTabClick('client_stock')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all text-left cursor-pointer ${
                    activeTab === 'client_stock'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Boxes className="w-4 h-4 shrink-0 text-emerald-400" />
                    <span>{language === 'ar' ? 'السطوك ديالي' : 'Mon Stock (Fulfillment)'}</span>
                  </div>
                  <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-emerald-300 force-ltr">
                    {clientStockProducts
                      .filter(p => {
                        if (!currentUser?.id || !p.clientId) return false;
                        const shopId = (currentUser as any)?.shopId;
                        return p.clientId === currentUser.id || (Boolean(shopId) && p.clientId === shopId);
                      })
                      .reduce((sum, p) => sum + p.units.filter(u => u.status === 'en_stock').length, 0)}
                  </span>
                </button>

                {/* 4. Mes Bons d'expédition */}
                <button
                  onClick={() => handleTabClick('client_bons')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_bons'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <FileText className="w-4 h-4 shrink-0 text-indigo-400" />
                    <span>{t('sidebar.clientBons', 'البونات ديالي (Bons Client)')}</span>
                  </div>
                  <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                    {bons.filter(b => b.type === 'client' && b.clientId === currentUser?.id).length}
                  </span>
                </button>

                {/* 5. Suivi des livraisons */}
                <button
                  onClick={() => handleTabClick('client_tracking')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_tracking'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <Search className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.clientTracking')}</span>
                </button>

                {/* 5. Demande de ramassage */}
                <button
                  onClick={() => handleTabClick('client_pickups')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_pickups'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <CalendarCheck className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.clientPickups')}</span>
                </button>

                {/* 6. Mes paiements */}
                <button
                  onClick={() => handleTabClick('client_finance')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_finance'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <BadgeDollarSign className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.clientFinance')}</span>
                </button>

                {/* 7. صور التحويلات البنكية (Reçus Bancaires) */}
                <button
                  onClick={() => handleTabClick('client_debts')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_debts'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <FileImage className="w-4 h-4 shrink-0" />
                    <span>{t('sidebar.clientDebts')}</span>
                  </span>
                  {myTransferReceiptsCount > 0 && (
                    <span className="font-mono text-[10px] bg-emerald-500 text-white px-1.5 rounded-full font-bold force-ltr">
                      {myTransferReceiptsCount}
                    </span>
                  )}
                </button>

                {/* 8. Mes retours */}
                <button
                  onClick={() => handleTabClick('client_returns')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_returns'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <CornerDownLeft className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.clientReturns')}</span>
                </button>

                {/* 9. Mes tarifs */}
                <button
                  onClick={() => handleTabClick('client_tariffs')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_tariffs'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <Tag className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.clientTariffs')}</span>
                </button>

                {/* 10. Messagerie & Support Client */}
                <button
                  onClick={() => handleTabClick('client_messages')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_messages'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <MessageSquare className="w-4 h-4 shrink-0 text-red-400" />
                    <span>{t('sidebar.clientSupportMessages', 'Messagerie & Support')}</span>
                  </div>
                  {clientActiveMessages > 0 && (
                    <span className="font-bold text-[10px] bg-red-600 text-white px-1.5 py-0.2 rounded-full force-ltr">
                      {clientActiveMessages}
                    </span>
                  )}
                </button>

                {/* 10b. Avis Clients & Livreurs */}
                <button
                  onClick={() => handleTabClick('client_reviews')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_reviews'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Star className="w-4 h-4 shrink-0 text-amber-400" />
                    <span>{language === 'ar' ? 'آراء الزبائن والليفرورز' : 'Avis & Évaluations'}</span>
                  </div>
                  {reviews.filter(r => r.isPublic !== false).length > 0 && (
                    <span className="font-mono text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-sm text-slate-300 force-ltr">
                      {reviews.filter(r => r.isPublic !== false).length}
                    </span>
                  )}
                </button>

                {/* 10c. Blacklist (اللائحة السوداء للزبناء) */}
                <button
                  onClick={() => handleTabClick('client_blacklist')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all text-left cursor-pointer ${
                    activeTab === 'client_blacklist'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400" />
                    <span>{t('sidebar.blacklist', 'اللائحة السوداء (Blacklist)')}</span>
                  </div>
                  {blacklistEntries.length > 0 && (
                    <span className="font-mono text-[10px] bg-rose-600 text-white px-1.5 py-0.5 rounded-full font-bold force-ltr">
                      {blacklistEntries.length}
                    </span>
                  )}
                </button>

                {/* 11. Mon profil */}
                <button
                  onClick={() => handleTabClick('client_profile')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'client_profile'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <User className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.clientProfile')}</span>
                </button>
              </>
            )}

            {/* DRIVER MENU */}
            {isDriver && (
              <>
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {t('sidebar.sectionDriver')}
                </div>

                <button
                  onClick={() => handleTabClick('driver_tour')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'driver_tour'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <Truck className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.driverTour')}</span>
                </button>

                <button
                  onClick={() => handleTabClick('driver_cash')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all text-left ${
                    activeTab === 'driver_cash'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <BadgeDollarSign className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.driverCash')}</span>
                </button>
              </>
            )}

            {/* PARTNER PORTAL MENU */}
            {currentRole === 'partner' && (
              <>
                <button
                  onClick={() => handleTabClick('partner_dashboard')}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl font-semibold transition-all cursor-pointer ${isRtl ? 'text-right' : 'text-left'} ${
                    activeTab === 'partner_dashboard'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <LayoutDashboard className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.partnerDashboard')}</span>
                </button>

                <div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {t('sidebar.partnerFunctions', 'FONCTIONS')}
                </div>

                <button
                  onClick={() => handleTabClick('partner_packages')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all cursor-pointer ${isRtl ? 'text-right' : 'text-left'} ${
                    activeTab === 'partner_packages'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Package className="w-4 h-4 shrink-0" />
                    <span>{t('sidebar.partnerPackages')}</span>
                  </div>
                  <span
                    className={`font-mono text-[10px] px-1.5 py-0.5 rounded-full font-bold force-ltr ${
                      activeTab === 'partner_packages'
                        ? 'bg-white text-red-600'
                        : 'bg-slate-800 text-slate-200'
                    }`}
                  >
                    {partnerParcels.length}
                  </span>
                </button>

                <button
                  onClick={() => handleTabClick('partner_relances')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all cursor-pointer ${isRtl ? 'text-right' : 'text-left'} ${
                    activeTab === 'partner_relances'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <RefreshCw className="w-4 h-4 shrink-0" />
                    <span>{t('sidebar.partnerRelances', 'Relances')}</span>
                  </div>
                  {partnerRelancesCount > 0 && (
                    <span className="font-mono text-[10px] bg-amber-500 text-slate-950 px-1.5 py-0.5 rounded-full font-bold force-ltr">
                      {partnerRelancesCount}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => handleTabClick('partner_returns')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all cursor-pointer ${isRtl ? 'text-right' : 'text-left'} ${
                    activeTab === 'partner_returns'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <CornerDownLeft className="w-4 h-4 shrink-0" />
                    <span>{t('sidebar.partnerReturns', 'Demandes de retour')}</span>
                  </div>
                  {partnerReturnsCount > 0 && (
                    <span className="font-mono text-[10px] bg-rose-500 text-white px-1.5 py-0.5 rounded-full font-bold force-ltr">
                      {partnerReturnsCount}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => handleTabClick('partner_payments')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all cursor-pointer ${isRtl ? 'text-right' : 'text-left'} ${
                    activeTab === 'partner_payments'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <Wallet className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.partnerPayments')}</span>
                </button>

                <button
                  onClick={() => handleTabClick('partner_receipts')}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl font-semibold transition-all cursor-pointer ${isRtl ? 'text-right' : 'text-left'} ${
                    activeTab === 'partner_receipts'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <Clock className="w-4 h-4 shrink-0" />
                  <span>{t('sidebar.partnerReceipts', 'Historique des reçus')}</span>
                </button>

                <button
                  onClick={() => handleTabClick('partner_api')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl font-semibold transition-all cursor-pointer ${isRtl ? 'text-right' : 'text-left'} ${
                    activeTab === 'partner_api'
                      ? 'bg-red-600 text-white font-bold shadow-xs'
                      : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Key className="w-4 h-4 shrink-0 text-amber-400" />
                    <span className={activeTab === 'partner_api' ? 'text-white font-bold' : 'text-amber-300 font-bold'}>
                      {t('sidebar.partnerApi')}
                    </span>
                  </div>
                  <span className="font-mono text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full font-bold">
                    REST
                  </span>
                </button>
              </>
            )}
          </nav>
        </div>

        {/* Bottom Actions: Scanner & Déconnexion */}
        <div className="p-4 border-t border-slate-800 space-y-2">
          <button
            onClick={onOpenScanner}
            className="w-full py-2 px-3 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 shadow-xs transition-colors cursor-pointer"
          >
            <Scan className="w-4 h-4" />
            <span>{t('sidebar.scanPackage')}</span>
          </button>

          {/* Déconnexion button */}
          <button
            onClick={handleLogout}
            className="w-full py-2 px-3 bg-slate-800 hover:bg-red-950/80 text-slate-300 hover:text-red-400 font-bold text-xs rounded-xl flex items-center justify-center gap-2 border border-slate-700/80 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{t('sidebar.logout')}</span>
          </button>

          <div className="flex items-center justify-center gap-2 pt-1">
            <a
              href={facebookUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Facebook"
              title="Facebook — FARIOUSY"
              className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-[#1877F2] text-[#1877F2] hover:text-white border border-slate-700/80 hover:border-[#1877F2] flex items-center justify-center transition-colors"
            >
              <FacebookIcon className="w-3.5 h-3.5" />
            </a>
            <a
              href={instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram"
              title="Instagram — @fariousy1"
              className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-gradient-to-tr hover:from-[#F58529] hover:via-[#DD2A7B] hover:to-[#8134AF] text-pink-400 hover:text-white border border-slate-700/80 hover:border-pink-500 flex items-center justify-center transition-colors"
            >
              <InstagramIcon className="w-3.5 h-3.5" />
            </a>
          </div>

          <div className="text-[10px] text-center text-slate-500 font-mono pt-0.5 force-ltr">
            {t('sidebar.version', 'FARIOUSY DELIVERY v1.0')}
          </div>
        </div>
      </aside>
    </>
  );
};
