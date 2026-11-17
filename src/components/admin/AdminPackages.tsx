import React, { useState } from 'react';
import { useDatabase } from '../../context/DatabaseContext';
import { useAuth } from '../../context/AuthContext';
import { PackageItem, PackageStatus, PACKAGE_STATUS_CONFIG } from '../../types';
import { formatMAD, formatDate } from '../../utils/barcode';
import { exportPackagesToCSV } from '../../utils/export';
import { downloadBatchTicketsPdf } from '../../utils/thermalTicketPdf';
import { suggestDriversForTarget, getBestDriverForTarget } from '../../utils/driverMatcher';
import {
  buildRecipientConfirmationWhatsAppUrl,
  hasValidRecipientWhatsApp,
  isPendingConfirmationStatus
} from '../../utils/supportWhatsApp';
import { ConfirmActionModal } from '../common/ConfirmActionModal';
import {
  Search,
  Plus,
  Scan,
  Download,
  Filter,
  Eye,
  Printer,
  Truck,
  Edit2,
  Trash2,
  X,
  Save,
  CheckCircle2,
  AlertTriangle,
  Archive,
  UserCheck,
  RefreshCw,
  Package,
  ChevronDown,
  UserPlus,
  Send,
  Copy,
  Check,
  FileText,
  FileSpreadsheet,
  Loader2,
  Zap,
  Sparkles,
  Camera,
  MessageCircle,
  ShieldAlert
} from 'lucide-react';

interface AdminPackagesProps {
  onOpenAddPackage: () => void;
  onOpenImportExcel?: () => void;
  onOpenScanner: () => void;
  onViewPackage: (pkg: PackageItem) => void;
  onPrintLabel: (pkg: PackageItem) => void;
  onDispatchToPartner?: (packageIds: string[]) => void;
  externalSearchQuery?: { query: string; nonce: number } | null;
}

export const AdminPackages: React.FC<AdminPackagesProps> = ({
  onOpenAddPackage,
  onOpenImportExcel,
  onOpenScanner,
  onViewPackage,
  onPrintLabel,
  onDispatchToPartner,
  externalSearchQuery
}) => {
  const {
    packages,
    isPackagesLoading,
    refreshPackages,
    cities,
    users,
    companySettings,
    updatePackage,
    deletePackage,
    changePackageStatus,
    assignPackageToDriver,
    assignMultiplePackagesToDriver,
    findBlacklistMatches
  } = useDatabase();
  const { currentUser } = useAuth();

  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  React.useEffect(() => {
    if (externalSearchQuery?.query) {
      setSearch(externalSearchQuery.query);
    }
  }, [externalSearchQuery?.nonce, externalSearchQuery?.query]);

  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>('all');
  const [selectedCityFilter, setSelectedCityFilter] = useState<string>('all');
  const [selectedClientFilter, setSelectedClientFilter] = useState<string>('all');
  const [updatingStatusPkgId, setUpdatingStatusPkgId] = useState<string | null>(null);
  const [statusNotification, setStatusNotification] = useState<{ message: string; isError?: boolean } | null>(null);

  // Sélection multiple et affectation des livreurs
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
  const [copiedPkgId, setCopiedPkgId] = useState<string | null>(null);
  const [showAssignModal, setShowAssignModal] = useState<boolean>(false);
  const [singlePackageToAssign, setSinglePackageToAssign] = useState<PackageItem | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');
  const [assignUpdateStatus, setAssignUpdateStatus] = useState<boolean>(true);
  const [isAssigning, setIsAssigning] = useState<boolean>(false);
  const [confirmedReassign, setConfirmedReassign] = useState<boolean>(false);
  const [isExportingBatchPdf, setIsExportingBatchPdf] = useState<boolean>(false);

  const handleBatchTicketsPdf = async () => {
    const selected = packages.filter(p => selectedPackageIds.includes(p.id));
    if (selected.length === 0) return;
    setIsExportingBatchPdf(true);
    try {
      await downloadBatchTicketsPdf(selected);
      setStatusNotification({
        message: `تم تصدير ${selected.length} تذكرة (100×100 mm) في ملف PDF بنجاح.`
      });
      setTimeout(() => setStatusNotification(null), 3500);
    } catch (err: any) {
      setStatusNotification({
        message: err?.message || 'خطأ أثناء تحويل التذاكر إلى PDF.',
        isError: true
      });
    } finally {
      setIsExportingBatchPdf(false);
    }
  };

  const handleRefresh = async () => {
    setIsManualRefreshing(true);
    try {
      await refreshPackages();
    } finally {
      setIsManualRefreshing(false);
    }
  };

  const handleRowStatusChange = async (pkg: PackageItem, newStatus: PackageStatus) => {
    if (newStatus === pkg.status) return;
    setUpdatingStatusPkgId(pkg.id);
    setStatusNotification(null);
    try {
      const res = await changePackageStatus(
        pkg.id,
        newStatus,
        `Statut modifié par ${currentUser?.name || 'Administrateur'} depuis la table`,
        undefined,
        currentUser ? { name: currentUser.name, role: currentUser.role } : undefined
      );
      if (res.success) {
        setStatusNotification({
          message: `Colis ${pkg.trackingNumber} : statut passé à « ${PACKAGE_STATUS_CONFIG[newStatus].label} » dans Supabase Production.`
        });
        setTimeout(() => setStatusNotification(null), 3500);
      } else {
        setStatusNotification({
          message: res.error || "Erreur lors de l'enregistrement du statut dans Supabase.",
          isError: true
        });
      }
    } finally {
      setUpdatingStatusPkgId(null);
    }
  };

  // Edit Package Modal State
  const [editingPackage, setEditingPackage] = useState<PackageItem | null>(null);
  const [editRecipientName, setEditRecipientName] = useState('');
  const [editRecipientPhone, setEditRecipientPhone] = useState('');
  const [editCity, setEditCity] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editProductPrice, setEditProductPrice] = useState(0);
  const [editDeliveryFee, setEditDeliveryFee] = useState(35);
  const [editCodAmount, setEditCodAmount] = useState(0);
  const [editDescription, setEditDescription] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editDriverId, setEditDriverId] = useState('');

  // Delete / Archive Modal State
  const [deletingPackage, setDeletingPackage] = useState<PackageItem | null>(null);

  const clients = users.filter(u => u.role === 'client');
  const drivers = users.filter(u => u.role === 'driver');

  // Filter packages
  const filteredPackages = packages.filter(pkg => {
    const matchesSearch =
      search === '' ||
      pkg.trackingNumber.toLowerCase().includes(search.toLowerCase()) ||
      pkg.recipientName.toLowerCase().includes(search.toLowerCase()) ||
      pkg.recipientPhone.includes(search) ||
      (pkg.clientCompany && pkg.clientCompany.toLowerCase().includes(search.toLowerCase()));

    const matchesStatus = selectedStatusFilter === 'all' || pkg.status === selectedStatusFilter;
    const matchesCity = selectedCityFilter === 'all' || pkg.city.toLowerCase() === selectedCityFilter.toLowerCase();
    const matchesClient = selectedClientFilter === 'all' || pkg.clientId === selectedClientFilter;

    return matchesSearch && matchesStatus && matchesCity && matchesClient;
  });

  const packagesToAssign = singlePackageToAssign
    ? [singlePackageToAssign]
    : packages.filter(p => selectedPackageIds.includes(p.id));

  const alreadyAssigned = packagesToAssign.filter(p => p.driverId && p.driverId !== selectedDriverId);
  const isReassignment = alreadyAssigned.length > 0 && selectedDriverId !== '';

  const assignTargetPkg = singlePackageToAssign || packagesToAssign[0] || null;
  const assignDriverSuggestions = suggestDriversForTarget({
    targetCity: assignTargetPkg?.city || '',
    targetAddress: assignTargetPkg?.address || '',
    drivers,
    cities,
    packages
  });
  const topAssignSuggestion = assignDriverSuggestions[0] || null;

  const handleAutoAssignPackages = async (targetPkgs: PackageItem[]) => {
    if (targetPkgs.length === 0) return;
    if (drivers.length === 0) {
      setStatusNotification({
        message: 'لا يوجد سائقون متاحون حالياً للتعيين التلقائي.',
        isError: true
      });
      return;
    }

    setIsAssigning(true);
    try {
      const groupedByDriver = new Map<string, { driverName: string; ids: string[] }>();
      targetPkgs.forEach(p => {
        const best = getBestDriverForTarget({
          targetCity: p.city,
          targetAddress: p.address,
          drivers,
          cities,
          packages
        });
        if (!best) return;
        const entry = groupedByDriver.get(best.driver.id) || {
          driverName: best.driver.name,
          ids: []
        };
        entry.ids.push(p.id);
        groupedByDriver.set(best.driver.id, entry);
      });

      let assignedCount = 0;
      for (const [driverId, group] of groupedByDriver.entries()) {
        if (group.ids.length === 1 && assignPackageToDriver) {
          await assignPackageToDriver(
            group.ids[0],
            driverId,
            group.driverName,
            true,
            currentUser ? { name: currentUser.name, role: currentUser.role } : undefined
          );
          assignedCount += 1;
        } else if (assignMultiplePackagesToDriver) {
          await assignMultiplePackagesToDriver(
            group.ids,
            driverId,
            group.driverName,
            true,
            currentUser ? { name: currentUser.name, role: currentUser.role } : undefined
          );
          assignedCount += group.ids.length;
        }
      }

      setStatusNotification({
        message: `⚡ تم التعيين التلقائي لـ ${assignedCount} طرد لأقرب السائقين بنجاح.`
      });
      setSelectedPackageIds([]);
      setTimeout(() => setStatusNotification(null), 4000);
    } finally {
      setIsAssigning(false);
    }
  };

  const handleToggleSelectAll = () => {
    if (selectedPackageIds.length === filteredPackages.length && filteredPackages.length > 0) {
      setSelectedPackageIds([]);
    } else {
      setSelectedPackageIds(filteredPackages.map(p => p.id));
    }
  };

  const handleToggleSelectPackage = (id: string) => {
    setSelectedPackageIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleOpenAssignModal = (pkg?: PackageItem) => {
    if (pkg) {
      setSinglePackageToAssign(pkg);
      const best = getBestDriverForTarget({
        targetCity: pkg.city,
        targetAddress: pkg.address,
        drivers,
        cities,
        packages
      });
      setSelectedDriverId(pkg.driverId || best?.driver.id || '');
    } else {
      setSinglePackageToAssign(null);
      const firstSelected = packages.find(p => selectedPackageIds.includes(p.id));
      const best = firstSelected
        ? getBestDriverForTarget({
            targetCity: firstSelected.city,
            targetAddress: firstSelected.address,
            drivers,
            cities,
            packages
          })
        : null;
      setSelectedDriverId(best?.driver.id || '');
    }
    setConfirmedReassign(false);
    setShowAssignModal(true);
  };

  const handleExecuteAssignment = async () => {
    if (isReassignment && !confirmedReassign) {
      setConfirmedReassign(true);
      return;
    }

    setIsAssigning(true);
    try {
      const selectedDriver = drivers.find(d => d.id === selectedDriverId);
      const targetIds = packagesToAssign.map(p => p.id);

      let res;
      if (singlePackageToAssign && assignPackageToDriver) {
        res = await assignPackageToDriver(
          singlePackageToAssign.id,
          selectedDriverId || null,
          selectedDriver?.name,
          assignUpdateStatus,
          currentUser ? { name: currentUser.name, role: currentUser.role } : undefined
        );
      } else if (assignMultiplePackagesToDriver) {
        res = await assignMultiplePackagesToDriver(
          targetIds,
          selectedDriverId ? selectedDriverId : null,
          selectedDriver?.name,
          assignUpdateStatus,
          currentUser ? { name: currentUser.name, role: currentUser.role } : undefined
        );
      }

      if (res && res.success) {
        setStatusNotification({
          message: res.message || `${targetIds.length} colis affecté(s) avec succès dans Supabase Production.`
        });
        setShowAssignModal(false);
        setSinglePackageToAssign(null);
        setSelectedPackageIds([]);
        setConfirmedReassign(false);
        setTimeout(() => setStatusNotification(null), 4000);
      } else {
        setStatusNotification({
          message: (res && res.error) || "Erreur lors de l'enregistrement de l'affectation dans Supabase.",
          isError: true
        });
      }
    } finally {
      setIsAssigning(false);
    }
  };

  const handleExportCSV = () => {
    exportPackagesToCSV(filteredPackages, `fariousy_colis_${new Date().toISOString().substring(0, 10)}.csv`);
  };

  const handleOpenEdit = (pkg: PackageItem) => {
    setEditingPackage(pkg);
    setEditRecipientName(pkg.recipientName);
    setEditRecipientPhone(pkg.recipientPhone);
    setEditCity(pkg.city);
    setEditAddress(pkg.address);
    setEditProductPrice(pkg.productPrice || 0);
    setEditDeliveryFee(pkg.deliveryFee || 35);
    setEditCodAmount(pkg.codAmount || 0);
    setEditDescription(pkg.description || '');
    setEditNotes(pkg.notes || '');
    setEditDriverId(pkg.driverId || '');
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPackage) return;

    const assignedDriver = drivers.find(d => d.id === editDriverId);

    updatePackage(
      editingPackage.id,
      {
        recipientName: editRecipientName.trim(),
        recipientPhone: editRecipientPhone.trim(),
        city: editCity,
        address: editAddress.trim(),
        productPrice: Number(editProductPrice),
        deliveryFee: Number(editDeliveryFee),
        codAmount: Number(editCodAmount),
        description: editDescription.trim(),
        notes: editNotes.trim(),
        driverId: editDriverId || undefined,
        driverName: assignedDriver?.name || undefined
      },
      currentUser ? { name: currentUser.name, role: currentUser.role, id: currentUser.id } : undefined
    );

    setEditingPackage(null);
  };

  const handleConfirmDelete = async (reason?: string) => {
    if (!deletingPackage) return;
    const target = deletingPackage;
    setDeletingPackage(null);
    const result = await deletePackage(
      target.id,
      reason || 'Suppression depuis la liste centrale des colis',
      currentUser ? { name: currentUser.name, role: currentUser.role, id: currentUser.id } : undefined
    );
    if (result.success) {
      setSelectedPackageIds(prev => prev.filter(pid => pid !== target.id));
    }
    setStatusNotification({
      message: result.message,
      isError: !result.success
    });
  };

  return (
    <div className="space-y-5">
      {/* Page Title & Main Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h2 className="text-xl font-black text-slate-900 tracking-tight">
            Gestion Centrale des Colis
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Lecture en direct depuis Supabase Production (public.packages) — {packages.length} colis enregistrés
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={isPackagesLoading || isManualRefreshing}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-60"
            title="Recharger les colis directement depuis Supabase Production"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-slate-600 ${isPackagesLoading || isManualRefreshing ? 'animate-spin' : ''}`} />
            <span>Actualiser</span>
          </button>

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl shadow-2xs transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-slate-600" />
            <span>Exporter CSV</span>
          </button>

          {/* Bouton Affecter à un livreur */}
          <button
            onClick={() => handleOpenAssignModal()}
            disabled={selectedPackageIds.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl shadow-xs transition-colors cursor-pointer"
            title="Affecter les colis sélectionnés à un livreur dans Supabase"
          >
            <Truck className="w-3.5 h-3.5" />
            <span>Affecter à un livreur {selectedPackageIds.length > 0 ? `(${selectedPackageIds.length})` : ''}</span>
          </button>

          <button
            onClick={onOpenScanner}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl shadow-2xs transition-colors cursor-pointer"
          >
            <Scan className="w-3.5 h-3.5 text-red-600" />
            <span>Scanner</span>
          </button>

          <button
            onClick={onOpenImportExcel || onOpenAddPackage}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 rounded-xl shadow-2xs transition-colors cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
            <span>Importer Excel</span>
          </button>

          <button
            onClick={onOpenAddPackage}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-xl shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Ajouter Colis</span>
          </button>
        </div>
      </div>

      {/* Barre d'action groupée pour colis sélectionnés */}
      {selectedPackageIds.length > 0 && (
        <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center justify-between text-xs text-indigo-950 animate-in fade-in slide-in-from-top-1 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="font-bold bg-indigo-600 text-white px-2.5 py-0.5 rounded-full text-[11px]">
              {selectedPackageIds.length}
            </span>
            <span className="font-semibold">colis sélectionné(s) pour tournée de livraison</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleBatchTicketsPdf}
              disabled={isExportingBatchPdf}
              className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60"
              title="تحميل تيكيات 100×100 بصيغة PDF جاهزة للطابعة"
            >
              {isExportingBatchPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5 text-red-400" />}
              <span>{isExportingBatchPdf ? 'جاري التحويل...' : `Tickets PDF 100×100 (${selectedPackageIds.length})`}</span>
            </button>
            <button
              onClick={() => handleAutoAssignPackages(packagesToAssign)}
              disabled={isAssigning}
              className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-black rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              title="تعيين تلقائي لكل طرد لأقرب سائق حسب المدينة والمنطقة"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>تعيين تلقائي للأقرب ({selectedPackageIds.length})</span>
            </button>
            <button
              onClick={() => handleOpenAssignModal()}
              className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Truck className="w-3.5 h-3.5" />
              <span>Affecter à un livreur</span>
            </button>
            {onDispatchToPartner && (
              <button
                onClick={() => onDispatchToPartner(selectedPackageIds)}
                className="px-3.5 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Transférer et lier les colis sélectionnés à un partenaire (ربط بالشريك)"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Envoyer au partenaire ({selectedPackageIds.length})</span>
              </button>
            )}
            <button
              onClick={() => setSelectedPackageIds([])}
              className="px-2.5 py-1.5 text-slate-600 hover:bg-indigo-100 rounded-lg transition-colors cursor-pointer"
            >
              Désélectionner tout
            </button>
          </div>
        </div>
      )}

      {/* Confirmation de modification de statut dans Supabase */}
      {statusNotification && (
        <div className={`p-3.5 rounded-xl border text-xs flex items-center justify-between transition-all animate-in fade-in slide-in-from-top-1 ${
          statusNotification.isError
            ? 'bg-rose-50 border-rose-200 text-rose-800'
            : 'bg-emerald-50 border-emerald-200 text-emerald-800 font-medium'
        }`}>
          <div className="flex items-center gap-2">
            {statusNotification.isError ? (
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            )}
            <span>{statusNotification.message}</span>
          </div>
          <button
            onClick={() => setStatusNotification(null)}
            className="p-1 hover:opacity-70 text-slate-500"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Filter Tabs / Quick Status Strip */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none text-xs">
        <button
          onClick={() => setSelectedStatusFilter('all')}
          className={`px-3 py-1.5 rounded-lg font-bold shrink-0 transition-colors cursor-pointer ${
            selectedStatusFilter === 'all'
              ? 'bg-slate-900 text-white'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          Tous ({packages.length})
        </button>
        {Object.entries(PACKAGE_STATUS_CONFIG).map(([key, meta]) => {
          const count = packages.filter(p => p.status === key).length;
          const isSelected = selectedStatusFilter === key;
          return (
            <button
              key={key}
              onClick={() => setSelectedStatusFilter(key)}
              className={`px-3 py-1.5 rounded-lg font-bold shrink-0 flex items-center gap-1.5 transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-red-600 text-white shadow-2xs'
                  : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: meta.dotColor }}
              />
              <span>{meta.label}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${isSelected ? 'bg-red-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Filter & Search Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs">
        <div className="sm:col-span-5 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher par N° suivi, client, destinataire, tél..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-mono"
          />
        </div>

        <div className="sm:col-span-3">
          <select
            value={selectedCityFilter}
            onChange={e => setSelectedCityFilter(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-semibold"
          >
            <option value="all">Toutes les villes ({cities.length})</option>
            {cities.map(c => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-4">
          <select
            value={selectedClientFilter}
            onChange={e => setSelectedClientFilter(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-semibold"
          >
            <option value="all">Toutes les boutiques ({clients.length})</option>
            {clients.map(c => (
              <option key={c.id} value={c.id}>
                {c.companyName || c.name} ({c.city})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Packages Table with Full Control */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs overflow-hidden">
        {/* DESKTOP TABLE VIEW (Visible on tablet & desktop: md and up) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-3 w-8">
                  <input
                    type="checkbox"
                    checked={filteredPackages.length > 0 && selectedPackageIds.length === filteredPackages.length}
                    onChange={handleToggleSelectAll}
                    title="Sélectionner tous les colis affichés"
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                </th>
                <th className="py-3 px-3.5">N° Suivi</th>
                <th className="py-3 px-3.5">Client / Boutique</th>
                <th className="py-3 px-3.5">Destinataire</th>
                <th className="py-3 px-3.5">Téléphone</th>
                <th className="py-3 px-3.5">Ville Destination</th>
                <th className="py-3 px-3.5 text-right">Montant COD</th>
                <th className="py-3 px-3.5">Livreur Affecté</th>
                <th className="py-3 px-3.5">Statut du Colis</th>
                <th className="py-3 px-3.5">Date de Création</th>
                <th className="py-3 px-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isPackagesLoading ? (
                <tr>
                  <td colSpan={11} className="py-16 text-center text-slate-500">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-red-600" />
                    <span className="text-xs font-semibold">Chargement des colis réels depuis Supabase Production...</span>
                  </td>
                </tr>
              ) : packages.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-16 text-center">
                    <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-3 text-slate-400">
                      <Package className="w-7 h-7 text-slate-400" />
                    </div>
                    <h3 className="text-base font-bold text-slate-800">Aucun colis enregistré</h3>
                    <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
                      Aucun colis n'est actuellement enregistré dans la table public.packages de Supabase Production.
                    </p>
                    <button
                      onClick={handleRefresh}
                      disabled={isPackagesLoading || isManualRefreshing}
                      className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors shadow-2xs cursor-pointer disabled:opacity-60"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isPackagesLoading || isManualRefreshing ? 'animate-spin' : ''}`} />
                      Actualiser
                    </button>
                  </td>
                </tr>
              ) : filteredPackages.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-slate-400">
                    Aucun colis ne correspond aux critères de recherche
                  </td>
                </tr>
              ) : (
                filteredPackages.map(pkg => {
                  const config = PACKAGE_STATUS_CONFIG[pkg.status] || {
                    label: pkg.status,
                    badgeClass: 'bg-slate-100 text-slate-700 border border-slate-200',
                    dotColor: '#64748b'
                  };
                  const isSelected = selectedPackageIds.includes(pkg.id);

                  return (
                    <tr key={pkg.id} className={`hover:bg-slate-50/70 transition-colors ${isSelected ? 'bg-indigo-50/40' : ''}`}>
                      {/* Checkbox */}
                      <td className="py-3 px-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleSelectPackage(pkg.id)}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                        />
                      </td>

                      {/* Numéro de suivi */}
                      <td className="py-3 px-3.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-extrabold text-red-600 block select-all">
                            {pkg.trackingNumber}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(pkg.trackingNumber);
                              setCopiedPkgId(pkg.id);
                              setTimeout(() => setCopiedPkgId(null), 2000);
                            }}
                            className="p-1 text-slate-400 hover:text-red-600 rounded transition cursor-pointer"
                            title="نسخ كود التتبع"
                          >
                            {copiedPkgId === pkg.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                        {pkg.currentAgency && (
                          <span className="text-[10px] text-slate-400 block font-sans">
                            {pkg.currentAgency}
                          </span>
                        )}
                      </td>

                      {/* Client / Boutique */}
                      <td className="py-3 px-3.5">
                        <span className="font-bold text-slate-900 block truncate max-w-[140px]">
                          {pkg.clientCompany || 'Boutique'}
                        </span>
                        {pkg.clientPhone && (
                          <span className="text-[10px] text-slate-500 font-mono block">
                            {pkg.clientPhone}
                          </span>
                        )}
                      </td>

                      {/* Destinataire */}
                      <td className="py-3 px-3.5">
                        <span className="font-semibold text-slate-900 block truncate max-w-[140px]">
                          {pkg.recipientName}
                        </span>
                      </td>

                      {/* Téléphone + Confirmation WhatsApp الزبون */}
                      <td className="py-3 px-3.5">
                        <span className="text-xs text-slate-700 font-mono font-medium block">
                          {pkg.recipientPhone}
                        </span>
                        {(() => {
                          const bl = findBlacklistMatches(pkg.recipientPhone);
                          if (bl.reportCount === 0) return null;
                          return (
                            <span
                              title={`هاد الزبون فاللائحة السوداء (${bl.reportCount}): ${bl.latestComment}`}
                              className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-100 border border-rose-300 text-rose-800 text-[10px] font-black"
                            >
                              <ShieldAlert className="w-3 h-3 shrink-0" />
                              <span>اللائحة السوداء ({bl.reportCount})</span>
                            </span>
                          );
                        })()}
                        {hasValidRecipientWhatsApp(pkg.recipientPhone) && isPendingConfirmationStatus(pkg.status) && (
                          <a
                            href={buildRecipientConfirmationWhatsAppUrl(pkg, companySettings?.companyName)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            title="إرسال رسالة تأكيد الطلبية للزبون عبر واتساب"
                            className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold shadow-2xs transition-colors"
                          >
                            <MessageCircle className="w-3 h-3 shrink-0" />
                            <span>تأكيد واتساب</span>
                          </a>
                        )}
                      </td>

                      {/* Ville */}
                      <td className="py-3 px-3.5">
                        <span className="font-bold text-slate-800 block">{pkg.city}</span>
                        {pkg.address && (
                          <span className="text-[10px] text-slate-400 block truncate max-w-[140px]">
                            {pkg.address}
                          </span>
                        )}
                      </td>

                      {/* Montant COD */}
                      <td className="py-3 px-3.5 text-right font-mono">
                        <span className="font-extrabold text-slate-900 text-sm block">
                          {formatMAD(pkg.codAmount)}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          Frais: {formatMAD(pkg.deliveryFee)}
                        </span>
                      </td>

                      {/* Livreur Affecté (Avec bouton d'assignation directe + Auto-Assign) */}
                      <td className="py-3 px-3.5">
                        {pkg.driverName || pkg.driverId ? (
                          <button
                            onClick={() => handleOpenAssignModal(pkg)}
                            className="inline-flex items-center gap-1.5 px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[11px] font-bold transition cursor-pointer"
                            title="Changer de livreur"
                          >
                            <Truck className="w-3 h-3 text-indigo-600" />
                            <span className="truncate max-w-[110px]">{pkg.driverName || 'Livreur Assigné'}</span>
                          </button>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleOpenAssignModal(pkg)}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-300 rounded-lg text-[10px] font-semibold transition cursor-pointer"
                              title="Assigner un livreur"
                            >
                              <UserPlus className="w-3 h-3 text-slate-400" />
                              <span>Affecter...</span>
                            </button>
                            <button
                              type="button"
                              disabled={isAssigning}
                              onClick={() => handleAutoAssignPackages([pkg])}
                              className="p-1 bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-300 rounded-lg transition cursor-pointer"
                              title="⚡ تعيين تلقائي لأقرب سائق"
                            >
                              <Zap className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Statut du Colis */}
                      <td className="py-3 px-3.5">
                        <div className="relative inline-flex items-center">
                          <select
                            value={pkg.status}
                            disabled={updatingStatusPkgId === pkg.id}
                            onChange={(e) => handleRowStatusChange(pkg, e.target.value as PackageStatus)}
                            title="Modifier le statut du colis dans Supabase Production"
                            className={`appearance-none pl-2.5 pr-6 py-1 rounded-lg text-[10px] font-bold border cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-500 transition-all ${config.badgeClass} disabled:opacity-60`}
                          >
                            {Object.entries(PACKAGE_STATUS_CONFIG).map(([key, meta]) => (
                              <option key={key} value={key} className="bg-white text-slate-800 text-xs font-semibold">
                                {meta.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="w-3 h-3 text-slate-500 absolute right-1.5 pointer-events-none" />
                        </div>
                        {(pkg.problemReport || pkg.callProofUrl) && (
                          <button
                            type="button"
                            onClick={() => onViewPackage(pkg)}
                            className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 hover:bg-red-200 text-red-700 text-[9px] font-bold cursor-pointer"
                            title="عرض تقرير المشكلة والصورة المرفقة"
                          >
                            <Camera className="w-2.5 h-2.5" />
                            <span>{pkg.problemReport?.photoBase64 || pkg.callProofUrl ? 'صورة المشكلة' : 'تفاصيل المشكلة'}</span>
                          </button>
                        )}
                        {updatingStatusPkgId === pkg.id && (
                          <span className="block text-[9px] text-red-600 font-bold mt-0.5 animate-pulse">
                            Enregistrement...
                          </span>
                        )}
                      </td>

                      {/* Date de création */}
                      <td className="py-3 px-3.5 text-slate-600 font-mono text-[11px]">
                        {formatDate(pkg.createdAt)}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-3.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {hasValidRecipientWhatsApp(pkg.recipientPhone) && (
                            <a
                              href={buildRecipientConfirmationWhatsAppUrl(pkg, companySettings?.companyName)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              title="إرسال رسالة تأكيد الطلبية للزبون عبر واتساب"
                              className="p-1.5 text-emerald-600 hover:text-white hover:bg-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg transition-colors"
                            >
                              <MessageCircle className="w-3.5 h-3.5" />
                            </a>
                          )}

                          <button
                            onClick={() => handleOpenEdit(pkg)}
                            title="Modifier le colis"
                            className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => onPrintLabel(pkg)}
                            title="Imprimer étiquette thermique"
                            className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>

                          {onDispatchToPartner && (
                            <button
                              onClick={() => onDispatchToPartner([pkg.id])}
                              title="Envoyer au partenaire (ربط بالشريك)"
                              className="p-1.5 text-slate-500 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
                            onClick={() => onViewPackage(pkg)}
                            title="Consulter détails du colis"
                            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => setDeletingPackage(pkg)}
                            title="Supprimer le colis"
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* MOBILE CARD VIEW (Optimized for Phones: screens under md) */}
        <div className="block md:hidden divide-y divide-slate-100">
          {isPackagesLoading ? (
            <div className="p-8 text-center text-slate-500">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-red-600" />
              <span className="text-xs font-semibold">Chargement des colis...</span>
            </div>
          ) : filteredPackages.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              Aucun colis trouvé
            </div>
          ) : (
            filteredPackages.map(pkg => {
              const config = PACKAGE_STATUS_CONFIG[pkg.status] || {
                label: pkg.status,
                badgeClass: 'bg-slate-100 text-slate-700 border border-slate-200'
              };
              const isSelected = selectedPackageIds.includes(pkg.id);

              return (
                <div key={pkg.id} className={`p-4 space-y-3 ${isSelected ? 'bg-indigo-50/40' : 'bg-white'}`}>
                  {/* Card Header: Tracking + Status + Checkbox */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleSelectPackage(pkg.id)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-black text-red-600 text-sm block">
                            {pkg.trackingNumber}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(pkg.trackingNumber);
                              setCopiedPkgId(pkg.id);
                              setTimeout(() => setCopiedPkgId(null), 2000);
                            }}
                            className="p-1 text-slate-400 hover:text-red-600 rounded transition cursor-pointer"
                            title="نسخ كود التتبع"
                          >
                            {copiedPkgId === pkg.id ? (
                              <Check className="w-3 h-3 text-emerald-600" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                        <span className="text-[10px] text-slate-500 block">
                          {pkg.clientCompany || 'Boutique'} • {formatDate(pkg.createdAt)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="font-mono font-black text-slate-900 text-base block">
                        {formatMAD(pkg.codAmount)}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold inline-block mt-0.5 ${config.badgeClass}`}>
                        {config.label}
                      </span>
                    </div>
                  </div>

                  {/* Recipient info & Destination */}
                  <div className="bg-slate-50 p-2.5 rounded-xl text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">{pkg.recipientName}</span>
                      <span className="font-mono text-red-600 font-semibold">{pkg.recipientPhone}</span>
                    </div>
                    <div className="text-[11px] text-slate-600 flex items-center justify-between">
                      <span className="font-bold text-slate-700">{pkg.city}</span>
                      <span className="text-slate-500 truncate max-w-[180px]">{pkg.address}</span>
                    </div>
                    {hasValidRecipientWhatsApp(pkg.recipientPhone) && (
                      <a
                        href={buildRecipientConfirmationWhatsAppUrl(pkg, companySettings?.companyName)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                          isPendingConfirmationStatus(pkg.status)
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                            : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200'
                        }`}
                      >
                        <MessageCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>تأكيد الطلبية مع الزبون (واتساب)</span>
                      </a>
                    )}
                    {pkg.driverName && (
                      <div className="text-[10px] text-indigo-700 font-bold flex items-center gap-1 pt-1 border-t border-slate-200">
                        <Truck className="w-3 h-3" />
                        <span>Livreur : {pkg.driverName}</span>
                      </div>
                    )}
                  </div>

                  {/* Quick Action Buttons for Mobile */}
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleOpenAssignModal(pkg)}
                        className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold rounded-lg border border-indigo-200 flex items-center gap-1 cursor-pointer"
                      >
                        <Truck className="w-3 h-3" />
                        <span>{pkg.driverName ? 'Changer' : 'Affecter'}</span>
                      </button>
                      <select
                        value={pkg.status}
                        disabled={updatingStatusPkgId === pkg.id}
                        onChange={(e) => handleRowStatusChange(pkg, e.target.value as PackageStatus)}
                        className="text-[11px] font-bold bg-white border border-slate-300 rounded-lg px-2 py-1 text-slate-800"
                      >
                        {Object.entries(PACKAGE_STATUS_CONFIG).map(([key, meta]) => (
                          <option key={key} value={key}>
                            {meta.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onPrintLabel(pkg)}
                        className="p-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                        title="Imprimer"
                      >
                        <Printer className="w-4 h-4 text-red-600" />
                      </button>
                      {onDispatchToPartner && (
                        <button
                          onClick={() => onDispatchToPartner([pkg.id])}
                          className="p-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                          title="Envoyer au partenaire (ربط بالشريك)"
                        >
                          <Send className="w-4 h-4 text-amber-600" />
                        </button>
                      )}
                      <button
                        onClick={() => onViewPackage(pkg)}
                        className="p-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                        title="Détails"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleOpenEdit(pkg)}
                        className="p-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                        title="Modifier"
                      >
                        <Edit2 className="w-4 h-4 text-blue-600" />
                      </button>
                      <button
                        onClick={() => setDeletingPackage(pkg)}
                        className="p-1.5 text-slate-700 bg-rose-50 hover:bg-rose-100 rounded-lg cursor-pointer"
                        title="Supprimer définitivement"
                      >
                        <Trash2 className="w-4 h-4 text-rose-600" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Info */}
        <div className="p-3.5 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 flex flex-col sm:flex-row justify-between items-center gap-2">
          <span>
            Affichage de <strong>{filteredPackages.length}</strong> sur <strong>{packages.length}</strong> colis
          </span>
          <span className="font-mono">
            Total COD filtré : <strong>{formatMAD(filteredPackages.reduce((acc, p) => acc + (p.codAmount || 0), 0))}</strong>
          </span>
        </div>
      </div>

      {/* ================= MODAL D'AFFECTATION LIVREUR (AJOUTÉ ET OPÉRATIONNEL) ================= */}
      {showAssignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs no-print">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
                  <Truck className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-slate-900">
                    Affecter à un Livreur
                  </h3>
                  <span className="text-[10px] text-slate-500">
                    {packagesToAssign.length} colis sélectionné(s)
                  </span>
                </div>
              </div>
              <button
                onClick={() => setShowAssignModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {topAssignSuggestion && (
                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center justify-between gap-2">
                  <div className="flex items-start gap-2 text-xs">
                    <Sparkles className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-extrabold text-indigo-950">
                        ⚡ أقرب سائق مقترح : {topAssignSuggestion.driver.name}
                      </div>
                      <div className="text-[11px] text-indigo-700">
                        {topAssignSuggestion.matchLabel} — {topAssignSuggestion.matchReason}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedDriverId(topAssignSuggestion.driver.id)}
                    className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-bold rounded-lg shrink-0 cursor-pointer"
                  >
                    اختيار
                  </button>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Sélectionner le livreur responsable (مرتبين حسب القرب) *
                </label>
                <select
                  value={selectedDriverId}
                  onChange={e => setSelectedDriverId(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-semibold"
                >
                  <option value="">-- Choisir un livreur ({drivers.length} disponibles) --</option>
                  {assignDriverSuggestions.map(s => (
                    <option key={s.driver.id} value={s.driver.id}>
                      {s.driver.name} {s.driver.phone ? `(${s.driver.phone})` : ''} - {s.driver.city || 'Laâyoune'} [{s.matchLabel}]
                    </option>
                  ))}
                </select>
                {drivers.length === 0 && (
                  <p className="text-[11px] text-amber-600 font-medium mt-1">
                    Aucun compte livreur actif trouvé. Créez un livreur dans « Gestion des Livreurs » d'abord.
                  </p>
                )}
              </div>

              {/* Option passer automatiquement en cours de livraison */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-800">Passer le statut à « En livraison »</div>
                  <div className="text-[10px] text-slate-500">Met à jour le statut du colis immédiatement</div>
                </div>
                <input
                  type="checkbox"
                  checked={assignUpdateStatus}
                  onChange={e => setAssignUpdateStatus(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer"
                />
              </div>

              {/* Avertissement si réaffectation */}
              {isReassignment && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900 space-y-1">
                  <div className="font-bold flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    <span>Réaffectation détectée</span>
                  </div>
                  <p>
                    Certains colis sont déjà assignés à un autre livreur. Confirmez-vous le transfert ?
                  </p>
                </div>
              )}

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAssignModal(false)}
                  className="px-4 py-2.5 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  disabled={!selectedDriverId || isAssigning}
                  onClick={handleExecuteAssignment}
                  className="px-4 py-2.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 rounded-xl shadow-xs flex items-center gap-1.5 transition"
                >
                  {isAssigning ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Affectation en cours...</span>
                    </>
                  ) : (
                    <>
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>Confirmer l'affectation</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Package Modal */}
      {editingPackage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs no-print">
          <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900">
                  Modifier le Colis {editingPackage.trackingNumber}
                </h3>
                <span className="text-[10px] text-slate-500">
                  Boutique : {editingPackage.clientCompany}
                </span>
              </div>
              <button
                onClick={() => setEditingPackage(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="p-6 space-y-3.5 overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Nom Destinataire *
                  </label>
                  <input
                    type="text"
                    required
                    value={editRecipientName}
                    onChange={e => setEditRecipientName(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Téléphone Destinataire *
                  </label>
                  <input
                    type="tel"
                    required
                    value={editRecipientPhone}
                    onChange={e => setEditRecipientPhone(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Ville de Destination
                  </label>
                  <select
                    value={editCity}
                    onChange={e => setEditCity(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-semibold"
                  >
                    {cities.map(c => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Livreur Assigné
                  </label>
                  <select
                    value={editDriverId}
                    onChange={e => setEditDriverId(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-semibold"
                  >
                    <option value="">Aucun (en attente)</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.city})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Adresse Complète *
                </label>
                <textarea
                  rows={2}
                  required
                  value={editAddress}
                  onChange={e => setEditAddress(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Prix Produit / Article (MAD) *
                  </label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={editProductPrice}
                    onChange={e => {
                      const p = Math.max(0, Number(e.target.value) || 0);
                      setEditProductPrice(p);
                      setEditCodAmount(Math.round((p + editDeliveryFee) * 100) / 100);
                    }}
                    className="w-full px-3 py-2 text-xs font-mono font-bold bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                  <span className="text-[10px] text-slate-400 block mt-0.5">Revenant au commerçant</span>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Frais Livraison (MAD) *
                  </label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={editDeliveryFee}
                    onChange={e => {
                      const f = Math.max(0, Number(e.target.value) || 0);
                      setEditDeliveryFee(f);
                      setEditCodAmount(Math.round((editProductPrice + f) * 100) / 100);
                    }}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                  <span className="text-[10px] text-slate-400 block mt-0.5">Revenu FARIOUSY</span>
                </div>
                <div>
                  <label className="block text-xs font-bold text-red-600 mb-1">
                    Total CRBT à encaisser (MAD)
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    readOnly
                    value={editCodAmount}
                    className="w-full px-3 py-2 text-xs font-mono font-black bg-red-50 border border-red-300 rounded-xl text-red-700 focus:outline-none"
                    title="Total CRBT = Prix article + Frais de livraison"
                  />
                  <span className="text-[10px] text-red-600 font-medium block mt-0.5">Livreur encaisse (Prix + Frais)</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Description de la marchandise
                </label>
                <input
                  type="text"
                  value={editDescription}
                  onChange={e => setEditDescription(e.target.value)}
                  placeholder="Ex: Robe en soie, Chaussures cuir..."
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Instructions ou remarques de livraison
                </label>
                <input
                  type="text"
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  placeholder="Ex: Appeler avant midi, livrer au bureau..."
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingPackage(null)}
                  className="px-4 py-2 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-xl shadow-xs flex items-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Enregistrer les modifications</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingPackage && (
        <ConfirmActionModal
          isOpen={Boolean(deletingPackage)}
          title="Suppression définitive du Colis"
          description={
            deletingPackage.status === 'livre' || deletingPackage.isPaidToClient
              ? `Attention : le colis ${deletingPackage.trackingNumber} est marqué « ${deletingPackage.status} ». En confirmant, il sera supprimé définitivement de Supabase et ne réapparaîtra plus.`
              : `Êtes-vous certain de vouloir supprimer définitivement le colis ${deletingPackage.trackingNumber} de ${deletingPackage.recipientName} (${deletingPackage.city}) de Supabase ?`
          }
          confirmLabel="Supprimer définitivement"
          isArchiveOrCancel={false}
          requireReason={true}
          onConfirm={reason => handleConfirmDelete(reason)}
          onClose={() => setDeletingPackage(null)}
        />
      )}
    </div>
  );
};
