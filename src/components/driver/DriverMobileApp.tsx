import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { useDatabase } from '../../context/DatabaseContext';
import { useAuth } from '../../context/AuthContext';
import { PackageItem, PackageStatus, PACKAGE_STATUS_CONFIG } from '../../types';
import { PWAInstallModal } from './PWAInstallModal';
import { ThermalLabelModal } from '../ThermalLabelModal';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { compressImageFileToDataUrl } from '../../utils/imageCompress';
import {
  PackageCheck,
  QrCode,
  Wallet,
  MapPin,
  Phone,
  MessageSquare,
  CheckCircle2,
  Clock,
  RotateCcw,
  X,
  Camera,
  PhoneOff,
  PhoneCall,
  MapPinOff,
  UserX,
  Navigation,
  FileSpreadsheet,
  Download,
  Smartphone,
  Sparkles,
  ShieldCheck,
  LogOut,
  Search,
  ArrowDownToLine,
  Check,
  Eraser,
  Bike,
  Car,
  RefreshCw,
  Wifi,
  WifiOff,
  Copy,
  SlidersHorizontal,
  ExternalLink,
  Printer,
  AlertTriangle,
  Star
} from 'lucide-react';

interface DriverMobileAppProps {
  onExitMobileView?: () => void;
}

const PROBLEM_CATEGORIES: { id: string; label: string }[] = [
  { id: 'adresse_introuvable', label: 'عنوان غير واضح / ناقص' },
  { id: 'client_injoignable', label: 'الزبون لا يجيب / مغلق' },
  { id: 'client_absent', label: 'الزبون غائب عن العنوان' },
  { id: 'colis_endommage', label: 'الطرد متضرر / مكسور' },
  { id: 'refus_paiement', label: 'رفض الدفع / ثمن مختلف' },
  { id: 'autre_probleme', label: 'مشكلة أخرى في التوصيل' }
];

// Complete Delivery Status Options for Driver
const DRIVER_STATUS_OPTIONS: {
  value: PackageStatus;
  label: string;
  labelAr: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  requiresProof?: boolean;
}[] = [
  { value: 'livre', label: 'Livré & Encaissé', labelAr: 'تم التوصيل واستلام المبلغ', icon: CheckCircle2, color: 'bg-emerald-600 text-white' },
  { value: 'probleme_livraison', label: 'Problème livraison', labelAr: 'تبليغ عن مشكلة بالصورة', icon: AlertTriangle, color: 'bg-red-600 text-white', requiresProof: true },
  { value: 'pas_de_reponse', label: 'Pas de réponse', labelAr: 'لا يجيب على الهاتف', icon: PhoneOff, color: 'bg-amber-600 text-white', requiresProof: true },
  { value: 'reporte', label: 'Livraison reportée', labelAr: 'طلب التأجيل لتاريخ لاحق', icon: Clock, color: 'bg-blue-600 text-white' },
  { value: 'refuse', label: 'Colis refusé', labelAr: 'رفض استلام الشحنة', icon: RotateCcw, color: 'bg-rose-700 text-white' },
  { value: 'en_cours_livraison', label: 'En cours de tournée', labelAr: 'قيد التوصيل الآن', icon: Navigation, color: 'bg-indigo-600 text-white' }
];

export const DriverMobileApp: React.FC<DriverMobileAppProps> = ({ onExitMobileView }) => {
  const { packages, changePackageStatus, reportPackageProblem, refreshPackages, reviews } = useDatabase();
  const { currentUser, logout } = useAuth();
  const { isInstallable, isInstalled } = usePWAInstall();

  const [activeTab, setActiveTab] = useState<'tour' | 'map' | 'scanner' | 'cash' | 'profile'>('tour');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'delivered' | 'issues'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [scannerActive, setScannerActive] = useState(false);
  const [scanMessage, setScanMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [copiedTracking, setCopiedTracking] = useState<string | null>(null);

  // Delivery Action Modal State
  const [selectedPkg, setSelectedPkg] = useState<PackageItem | null>(null);
  const [ticketPkg, setTicketPkg] = useState<PackageItem | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<PackageStatus>('livre');
  const [driverComment, setDriverComment] = useState<string>('');
  const [postponedDate, setPostponedDate] = useState<string>('');
  const [refusalReason, setRefusalReason] = useState<string>('Client a changé d\'avis');
  const [problemCategory, setProblemCategory] = useState<string>('adresse_introuvable');
  const [callProofBase64, setCallProofBase64] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Touch Signature Pad State
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  // File Input Ref for Call Proof
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Online / Offline Detection
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Beep sound generation using Web Audio API on scan
  const playBeep = useCallback((success = true) => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (success) {
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
        osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.08); // E6 note
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
      } else {
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
      }

      // Haptic feedback on mobile if supported
      if ('vibrate' in navigator) {
        navigator.vibrate(success ? [100, 50, 100] : [250]);
      }
    } catch (_) {}
  }, []);

  // Filter packages strictly for this driver
  const myPackages = useMemo(() => {
    const list = Array.isArray(packages) ? packages : [];
    const filtered = list.filter((p: PackageItem) => {
      if (!p.driverId) return false;
      return p.driverId === currentUser?.id || (currentUser?.email && p.driverName?.toLowerCase() === currentUser.name?.toLowerCase());
    });

    // Save offline backup
    if (filtered.length > 0 && currentUser?.id) {
      try {
        localStorage.setItem(`fariousy_driver_cache_${currentUser.id}`, JSON.stringify(filtered));
      } catch (_) {}
    }

    // Fallback to offline cache if empty and offline
    if (filtered.length === 0 && !navigator.onLine && currentUser?.id) {
      try {
        const cached = localStorage.getItem(`fariousy_driver_cache_${currentUser.id}`);
        if (cached) return JSON.parse(cached);
      } catch (_) {}
    }

    return filtered;
  }, [packages, currentUser?.id, currentUser?.name, currentUser?.email]);

  // Cash / COD Statistics
  const cashStats = useMemo(() => {
    let collected = 0;
    let pending = 0;
    let deliveredCount = 0;
    let returnedCount = 0;

    myPackages.forEach((p: PackageItem) => {
      const amount = Number(p.codAmount || 0);
      if (p.status === 'livre') {
        collected += amount;
        deliveredCount++;
      } else if (p.status === 'refuse' || p.status === 'retourne' || p.status === 'retour_en_cours') {
        returnedCount++;
      } else {
        pending += amount;
      }
    });

    return {
      collected,
      pending,
      deliveredCount,
      returnedCount,
      totalCount: myPackages.length
    };
  }, [myPackages]);

  // Barcode Scanner Listener
  useEffect(() => {
    let scanner: any = null;
    if (scannerActive) {
      setScanMessage(null);
      scanner = new Html5QrcodeScanner('reader-driver-full', { fps: 12, qrbox: { width: 260, height: 260 } }, false);
      scanner.render(
        (decodedText: string) => {
          const cleanCode = decodedText.trim().toUpperCase();
          const target = myPackages.find(
            (p: PackageItem) => (p.trackingNumber || '').toUpperCase() === cleanCode || (p.id || '').toUpperCase() === cleanCode
          );

          if (target) {
            playBeep(true);
            setScanMessage({ text: `Trouvé: ${target.trackingNumber}`, type: 'success' });
            openActionModal(target);
            setScannerActive(false);
          } else {
            playBeep(false);
            setScanMessage({ text: `Colis non trouvé dans votre tournée (${cleanCode})`, type: 'error' });
          }
        },
        () => {}
      );
    }
    return () => {
      if (scanner) {
        scanner.clear().catch(() => {});
      }
    };
  }, [scannerActive, myPackages, playBeep]);

  const openActionModal = (pkg: PackageItem, initialStatus: PackageStatus = 'livre') => {
    setSelectedPkg(pkg);
    setSelectedStatus(initialStatus);
    setDriverComment('');
    setPostponedDate('');
    setRefusalReason('Client a changé d\'avis');
    setProblemCategory('adresse_introuvable');
    setCallProofBase64(null);
    setHasSignature(false);

    // Clear signature canvas after modal mount
    setTimeout(() => {
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      }
    }, 100);
  };

  // Canvas Touch Signature Functions
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    setHasSignature(true);
    draw(e);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';

    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const clearSignature = () => {
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        ctx.beginPath();
      }
    }
    setHasSignature(false);
  };

  // Proof image upload handler with compression
  const handleProofImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageFileToDataUrl(file, 1024, 0.76);
      setCallProofBase64(compressed);
    } catch {
      const reader = new FileReader();
      reader.onloadend = () => {
        setCallProofBase64(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Save Status to Backend
  const handleSaveStatusWithProof = async () => {
    if (!selectedPkg) return;

    setIsSubmitting(true);
    try {
      if (selectedStatus === 'probleme_livraison') {
        const catObj = PROBLEM_CATEGORIES.find(c => c.id === problemCategory) || PROBLEM_CATEGORIES[0];
        const desc = driverComment.trim() || catObj.label;
        await reportPackageProblem({
          packageId: selectedPkg.id,
          category: catObj.id,
          categoryLabel: catObj.label,
          description: desc,
          photoBase64: callProofBase64 || undefined,
          reportedBy: currentUser
            ? { id: currentUser.id, name: currentUser.name, role: currentUser.role }
            : undefined
        });
        playBeep(true);
        setSelectedPkg(null);
        setDriverComment('');
        setCallProofBase64(null);
        return;
      }

      let fullComment = driverComment.trim();

      if (selectedStatus === 'reporte' && postponedDate) {
        fullComment = `Reporté au ${postponedDate}. ${fullComment}`.trim();
      } else if (selectedStatus === 'refuse' && refusalReason) {
        fullComment = `Motif refus : ${refusalReason}. ${fullComment}`.trim();
      } else if (selectedStatus === 'pas_de_reponse') {
        fullComment = `Appels sans réponse. ${fullComment}`.trim();
      }

      // If client signed on canvas
      if (selectedStatus === 'livre' && hasSignature && canvasRef.current) {
        fullComment = `${fullComment} [Signature client enregistrée]`.trim();
      }

      await changePackageStatus(
        selectedPkg.id,
        selectedStatus,
        fullComment,
        currentUser?.city || selectedPkg.city,
        currentUser ? { name: currentUser.name, role: currentUser.role } : undefined
      );

      playBeep(true);
      setSelectedPkg(null);
      setDriverComment('');
      setCallProofBase64(null);
    } catch (err: any) {
      alert(`Erreur lors de la mise à jour : ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Direct Phone Call
  const handleCall = (phone: string) => {
    if (!phone) return;
    window.location.href = `tel:${phone.replace(/\s+/g, '')}`;
  };

  // Direct WhatsApp with Darija Pre-filled Message
  const handleWhatsApp = (phone: string, tracking: string, codAmount: number, recipient: string, address: string) => {
    if (!phone) return;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const standardPhone = cleanPhone.startsWith('0') ? `212${cleanPhone.slice(1)}` : cleanPhone;
    const msg = encodeURIComponent(
      `السلام عليكم ${recipient || 'أخي/أختي'}، معاك موزع FARIOUSY DELIVERY 🚚 عندي ليك أمانة (كود: ${tracking}) بمبلغ ${codAmount} درهم. واش نتا متواجد فالعنوان (${address || 'العنوان'}) باش نسلمك الكولي؟ شكراً.`
    );
    window.open(`https://wa.me/${standardPhone}?text=${msg}`, '_blank');
  };

  // Direct Google Maps GPS Navigation
  const handleOpenGoogleMaps = (address: string, city: string) => {
    const destination = encodeURIComponent(`${address || ''}, ${city || 'Laâyoune'}, Maroc`);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destination}`, '_blank');
  };

  // Copy tracking code
  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedTracking(code);
    setTimeout(() => setCopiedTracking(null), 2000);
  };

  // Filtered packages by tab & search
  const filteredPackages = useMemo(() => {
    return myPackages.filter((p: PackageItem) => {
      // 1. Status Filter
      if (statusFilter === 'pending') {
        if (p.status === 'livre' || p.status === 'refuse' || p.status === 'retourne') return false;
      } else if (statusFilter === 'delivered') {
        if (p.status !== 'livre') return false;
      } else if (statusFilter === 'issues') {
        if (
          p.status !== 'probleme_livraison' &&
          p.status !== 'pas_de_reponse' &&
          p.status !== 'reporte' &&
          p.status !== 'refuse'
        )
          return false;
      }

      // 2. Search Query
      if (!searchTerm.trim()) return true;
      const q = searchTerm.toLowerCase();
      return (
        p.trackingNumber.toLowerCase().includes(q) ||
        p.recipientName.toLowerCase().includes(q) ||
        p.recipientPhone.toLowerCase().includes(q) ||
        p.city.toLowerCase().includes(q) ||
        p.address.toLowerCase().includes(q)
      );
    });
  }, [myPackages, statusFilter, searchTerm]);

  // Export Cash Report (CSV)
  const handleExportCashReport = () => {
    const rows = [
      ['Rapport de Caisse Livreur', 'FARIOUSY DELIVERY SARL'],
      ['Date', new Date().toLocaleDateString('fr-FR')],
      ['Livreur', currentUser?.name || 'Livreur'],
      ['Téléphone', currentUser?.phone || 'N/A'],
      ['Total Encaissé (DH)', String(cashStats.collected)],
      ['Total Restant (DH)', String(cashStats.pending)],
      [],
      ['Code Suivi', 'Destinataire', 'Téléphone', 'Ville', 'Statut', 'Montant COD (DH)']
    ];

    myPackages.forEach((p: PackageItem) => {
      rows.push([
        p.trackingNumber,
        p.recipientName,
        p.recipientPhone,
        p.city,
        PACKAGE_STATUS_CONFIG[p.status as PackageStatus]?.label || p.status,
        String(p.codAmount)
      ]);
    });

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + rows.map(r => r.join(';')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Caisse_Livreur_${currentUser?.name || 'Tour'}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-20">
      {/* ================= 1. TOP MOBILE HEADER ================= */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur-md border-b border-slate-800/90 px-4 py-2.5 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center p-1 shadow-md">
            <img 
              src="/assets/aistudio/WhatsApp_Image_2026-10-25_at_01.07.07_dafc315a.jpeg" 
              alt="Logo FARIOUSY" 
              className="w-full h-full object-contain rounded-lg"
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-black text-white tracking-tight">FARIOUSY Driver</span>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            </div>
            <div className="text-[10px] text-slate-400 font-medium flex items-center gap-1">
              <span>{currentUser?.name || 'Mouzawwi3'}</span>
              <span>•</span>
              <span className="text-amber-400">{currentUser?.city || 'Laâyoune'}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Online / Offline Indicator */}
          <div className={`px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 border ${
            isOnline 
              ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40' 
              : 'bg-amber-950/60 text-amber-400 border-amber-800/40 animate-pulse'
          }`}>
            {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            <span>{isOnline ? 'En ligne' : 'Hors-ligne'}</span>
          </div>

          {/* Install APK Button */}
          {!isInstalled && (
            <button
              onClick={() => setShowInstallModal(true)}
              className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white rounded-lg text-[10px] font-black flex items-center gap-1 shadow-xs animate-bounce"
            >
              <Smartphone className="w-3 h-3" />
              <span>APK</span>
            </button>
          )}

          {/* Sync Refresh */}
          <button
            onClick={() => refreshPackages()}
            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700/60"
            title="Rafraîchir les colis"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          {/* Exit / Logout */}
          <button
            onClick={() => {
              if (onExitMobileView) {
                onExitMobileView();
              } else {
                logout();
              }
            }}
            className="p-1.5 bg-rose-950/60 hover:bg-rose-900 text-rose-300 rounded-lg border border-rose-800/40"
            title="Déconnexion"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* ================= 2. MAIN CONTENT AREA ================= */}
      <main className="flex-1 p-3.5 max-w-lg mx-auto w-full space-y-4">
        {/* ================= VUE 1 : TOURNÉE DU JOUR ================= */}
        {activeTab === 'tour' && (
          <div className="space-y-3.5">
            {/* Quick KPI Strip */}
            <div className="grid grid-cols-4 gap-2">
              <div 
                onClick={() => setStatusFilter('all')}
                className={`p-2.5 rounded-xl border text-center cursor-pointer transition ${
                  statusFilter === 'all' 
                    ? 'bg-slate-800 border-red-500 text-white shadow-xs' 
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <span className="text-[10px] font-bold block uppercase">Total</span>
                <span className="text-base font-black text-white">{myPackages.length}</span>
              </div>

              <div 
                onClick={() => setStatusFilter('pending')}
                className={`p-2.5 rounded-xl border text-center cursor-pointer transition ${
                  statusFilter === 'pending' 
                    ? 'bg-amber-950/50 border-amber-500 text-amber-300 shadow-xs' 
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <span className="text-[10px] font-bold block uppercase">À Livrer</span>
                <span className="text-base font-black text-amber-400">
                  {myPackages.filter((p: PackageItem) => p.status !== 'livre' && p.status !== 'refuse' && p.status !== 'retourne').length}
                </span>
              </div>

              <div 
                onClick={() => setStatusFilter('delivered')}
                className={`p-2.5 rounded-xl border text-center cursor-pointer transition ${
                  statusFilter === 'delivered' 
                    ? 'bg-emerald-950/50 border-emerald-500 text-emerald-300 shadow-xs' 
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <span className="text-[10px] font-bold block uppercase">Livrés</span>
                <span className="text-base font-black text-emerald-400">{cashStats.deliveredCount}</span>
              </div>

              <div 
                onClick={() => setStatusFilter('issues')}
                className={`p-2.5 rounded-xl border text-center cursor-pointer transition ${
                  statusFilter === 'issues' 
                    ? 'bg-rose-950/50 border-rose-500 text-rose-300 shadow-xs' 
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                <span className="text-[10px] font-bold block uppercase">Problèmes</span>
                <span className="text-base font-black text-rose-400">
                  {myPackages.filter((p: PackageItem) => p.status === 'probleme_livraison' || p.status === 'pas_de_reponse' || p.status === 'reporte' || p.status === 'refuse').length}
                </span>
              </div>
            </div>

            {/* Driver Rules / Charter Notice */}
            <div
              dir="rtl"
              className="no-translate bg-gradient-to-l from-amber-950/75 via-slate-900 to-slate-900 border border-amber-500/40 rounded-2xl p-3.5 shadow-sm"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4 text-amber-400" />
                </div>
                <h3 className="text-xs font-black text-amber-300">
                  تعليمات التوصيل الإلزامية للموزع
                </h3>
              </div>
              <div className="space-y-1.5 text-xs text-slate-100">
                <div className="flex items-center gap-2 bg-slate-950/60 border border-slate-800/80 rounded-xl px-3 py-2">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="font-bold">ضرورة احترام الزبون</span>
                </div>
                <div className="flex items-center gap-2 bg-slate-950/60 border border-slate-800/80 rounded-xl px-3 py-2">
                  <PhoneCall className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="font-bold">ضرورة الاتصال بالزبون 3 مرات على الأقل</span>
                </div>
              </div>
            </div>

            {/* Search Bar */}
            <div className="relative">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
              <input
                type="text"
                placeholder="Rechercher : Code, Nom, Téléphone, Adresse..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-8 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500 transition"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Parcel Cards List */}
            <div className="space-y-3">
              {filteredPackages.length === 0 ? (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-500 mx-auto">
                    <PackageCheck className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-300">Aucun colis correspondant</h4>
                  <p className="text-xs text-slate-500">
                    {searchTerm ? "Aucun résultat trouvé pour cette recherche." : "Vous n'avez aucun colis affecté pour l'instant."}
                  </p>
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      className="text-xs font-bold text-red-400 underline"
                    >
                      Effacer la recherche
                    </button>
                  )}
                </div>
              ) : (
                filteredPackages.map((pkg: PackageItem) => {
                  const isDelivered = pkg.status === 'livre';
                  const isIssue =
                    pkg.status === 'probleme_livraison' ||
                    pkg.status === 'pas_de_reponse' ||
                    pkg.status === 'reporte' ||
                    pkg.status === 'refuse';
                  const statusConf = PACKAGE_STATUS_CONFIG[pkg.status as PackageStatus] || { label: pkg.status, badgeClass: 'bg-slate-800 text-slate-300' };

                  return (
                    <div
                      key={pkg.id}
                      className={`bg-slate-900 border rounded-2xl p-4 shadow-sm space-y-3 transition-all ${
                        isDelivered 
                          ? 'border-emerald-900/60 bg-gradient-to-b from-slate-900 to-emerald-950/20' 
                          : isIssue 
                          ? 'border-rose-900/60 bg-gradient-to-b from-slate-900 to-rose-950/20' 
                          : 'border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      {/* Top Info */}
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11px] font-bold text-slate-200 bg-slate-800 px-2 py-0.5 rounded">
                              {pkg.trackingNumber}
                            </span>
                            <button
                              type="button"
                              onClick={() => setTicketPkg(pkg)}
                              className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition flex items-center gap-1 text-[10px] cursor-pointer"
                              title="معاينة وطباعة تذكرة الشحن"
                            >
                              <Printer className="w-3 h-3 text-red-400" />
                              <span>تيكي</span>
                            </button>
                            <button
                              onClick={() => handleCopy(pkg.trackingNumber)}
                              className="text-slate-500 hover:text-slate-300 p-0.5"
                              title="Copier le code"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                            {copiedTracking === pkg.trackingNumber && (
                              <span className="text-[9px] text-emerald-400 font-bold">Copié!</span>
                            )}
                          </div>
                          <h3 className="font-black text-sm text-white mt-1.5">{pkg.recipientName}</h3>
                          <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                            <MapPin className="w-3 h-3 text-red-500 shrink-0" />
                            <span className="truncate">{pkg.address}, {pkg.city}</span>
                          </p>
                        </div>

                        {/* CRBT Amount */}
                        <div className="text-right shrink-0">
                          <span className="text-[10px] text-slate-400 uppercase font-bold block">À encaisser (COD)</span>
                          <span className="text-lg font-black text-emerald-400">
                            {pkg.codAmount} <span className="text-xs font-bold text-emerald-500">DH</span>
                          </span>
                          <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full inline-block mt-1 ${statusConf.badgeClass}`}>
                            {statusConf.label}
                          </span>
                        </div>
                      </div>

                      {/* Delivery Options Badges (Ouvrir / Essayage / Échange / Attention FRAGILE) */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border ${pkg.allowOpen ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700/60' : 'bg-slate-800/80 text-slate-300 border-slate-700'}`}>
                          Ouvrir : {pkg.allowOpen ? 'Oui (مسموح)' : 'Non (ممنوع)'}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border ${pkg.allowTry ? 'bg-blue-950/70 text-blue-300 border-blue-700/60' : 'bg-slate-800/80 text-slate-300 border-slate-700'}`}>
                          Essayage : {pkg.allowTry ? 'Oui (مسموح)' : 'Non (لا)'}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border ${pkg.isExchange ? 'bg-amber-950/70 text-amber-300 border-amber-700/60' : 'bg-slate-800/80 text-slate-300 border-slate-700'}`}>
                          Échange : {pkg.isExchange ? 'Oui' : 'Non'}
                        </span>
                        {pkg.isFragile && (
                          <span className="text-[10px] font-black px-2 py-0.5 rounded-lg border bg-rose-950/80 text-rose-200 border-rose-500/80">
                            ⚠️ Attention FRAGILE
                          </span>
                        )}
                      </div>

                      {/* FRAGILE ALERT (طرد قابل للكسر) */}
                      {pkg.isFragile && (
                        <div className="bg-rose-950/70 border border-rose-500/70 rounded-xl px-2.5 py-2 text-xs text-rose-100 flex items-center gap-2 shadow-xs">
                          <span className="text-sm shrink-0">⚠️</span>
                          <span className="font-bold">
                            Attention FRAGILE — طرد قابل للكسر، تعامل معه بعناية فائقة!
                          </span>
                        </div>
                      )}

                      {/* EXCHANGE ALERT (طرد استبدال) */}
                      {pkg.isExchange && (
                        <div className="bg-amber-950/70 border border-amber-600/70 rounded-xl p-2.5 text-xs text-amber-200 flex items-start gap-2 shadow-xs">
                          <span className="text-base shrink-0 mt-0.5">🔄</span>
                          <div className="flex-1 leading-tight">
                            <div className="font-bold text-amber-300">
                              طرد استبدال (Colis d'échange)
                            </div>
                            <div className="text-[11px] text-amber-100 font-mono mt-0.5">
                              يجب استرجاع الطرد القديم : <strong className="text-white">{pkg.exchangeTrackingNumber || 'رقم غير محدد'}</strong>
                            </div>
                            {pkg.exchangeReason && (
                              <div className="text-[10px] text-amber-300 mt-0.5">
                                السبب : {pkg.exchangeReason} {pkg.exchangeItemDescription ? `(${pkg.exchangeItemDescription})` : ''}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Comment / History Preview */}
                      {pkg.history && pkg.history.length > 0 && (
                        <div className="bg-slate-950/60 p-2 rounded-xl text-[10px] text-slate-400 flex items-center justify-between">
                          <span className="truncate">
                            Dernier statut : {pkg.history[pkg.history.length - 1].comment || pkg.history[pkg.history.length - 1].statusLabel}
                          </span>
                          <span className="shrink-0 font-mono text-slate-500">
                            {pkg.history[pkg.history.length - 1].timestamp.slice(-5)}
                          </span>
                        </div>
                      )}

                      {/* 3 Quick Driver Action Buttons */}
                      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-slate-800/80">
                        {/* Call */}
                        <button
                          type="button"
                          onClick={() => handleCall(pkg.recipientPhone)}
                          className="py-2 px-2 bg-blue-950/60 hover:bg-blue-900 border border-blue-800/50 rounded-xl text-blue-300 text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
                        >
                          <Phone className="w-3.5 h-3.5" />
                          <span>اتصال</span>
                        </button>

                        {/* WhatsApp */}
                        <button
                          type="button"
                          onClick={() => handleWhatsApp(pkg.recipientPhone, pkg.trackingNumber, pkg.codAmount, pkg.recipientName, pkg.address)}
                          className="py-2 px-2 bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-800/50 rounded-xl text-emerald-300 text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                          <span>واتساب</span>
                        </button>

                        {/* Google Maps GPS */}
                        <button
                          type="button"
                          onClick={() => handleOpenGoogleMaps(pkg.address, pkg.city)}
                          className="py-2 px-2 bg-purple-950/60 hover:bg-purple-900 border border-purple-800/50 rounded-xl text-purple-300 text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
                        >
                          <Navigation className="w-3.5 h-3.5" />
                          <span>الخريطة</span>
                        </button>
                      </div>

                      {/* Problem Report Preview on Card */}
                      {pkg.problemReport && (
                        <div className="bg-red-950/50 border border-red-700/60 rounded-xl p-2.5 text-[11px] text-red-100 flex items-center gap-2.5">
                          {pkg.problemReport.photoBase64 && (
                            <img
                              src={pkg.problemReport.photoBase64}
                              alt="صورة المشكلة"
                              className="w-11 h-11 rounded-lg object-cover border border-red-500/40 shrink-0"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="font-bold text-red-300 flex items-center gap-1">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{pkg.problemReport.categoryLabel}</span>
                            </div>
                            <p className="text-[10px] text-red-200/90 truncate">{pkg.problemReport.description}</p>
                          </div>
                        </div>
                      )}

                      {/* Primary Action Buttons */}
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => openActionModal(pkg)}
                          className={`col-span-2 py-2.5 rounded-xl text-xs font-black shadow-md flex items-center justify-center gap-1.5 active:scale-98 transition cursor-pointer ${
                            isDelivered
                              ? 'bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-emerald-800/40'
                              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                          }`}
                        >
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>{isDelivered ? 'تعديل الحالة' : 'تحديث / تم التسليم'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openActionModal(pkg, 'probleme_livraison')}
                          className="py-2.5 px-2 rounded-xl text-xs font-black bg-red-950/80 hover:bg-red-900 text-red-300 border border-red-700/70 flex items-center justify-center gap-1 active:scale-98 transition cursor-pointer"
                          title="تبليغ عن مشكلة في التوصيل مع إرفاق صورة"
                        >
                          <Camera className="w-3.5 h-3.5 shrink-0" />
                          <span>مشكلة</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ================= VUE 2 : SCANNER CAMÉRA ================= */}
        {activeTab === 'scanner' && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 text-center space-y-4">
              <div>
                <h3 className="text-sm font-black text-white flex items-center justify-center gap-2">
                  <QrCode className="w-4 h-4 text-red-500" />
                  <span>سكانير الباركود و QR Code</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  وجه الكاميرا نحو باركود الشحنة للتعرف عليها فوراً
                </p>
              </div>

              {/* Camera Scanner Box */}
              <div 
                id="reader-driver-full" 
                className="overflow-hidden rounded-2xl bg-black border border-slate-800 min-h-[280px]"
              />

              {scanMessage && (
                <div className={`p-3 rounded-xl text-xs font-bold ${
                  scanMessage.type === 'success' 
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' 
                    : 'bg-rose-950 text-rose-300 border border-rose-800'
                }`}>
                  {scanMessage.text}
                </div>
              )}

              {/* Manual search fallback */}
              <div className="pt-2 border-t border-slate-800">
                <span className="text-[11px] text-slate-400 block mb-2">أو أدخل رقم التتبع يدوياً إذا كان الباركود غير واضح :</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Ex: FAR-2601-..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-red-500 font-mono"
                  />
                  <button
                    onClick={() => {
                      const clean = searchTerm.trim().toUpperCase();
                      const target = myPackages.find((p: PackageItem) => p.trackingNumber.toUpperCase() === clean);
                      if (target) {
                        openActionModal(target);
                      } else {
                        alert("Colis non trouvé dans votre tournée.");
                      }
                    }}
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-bold"
                  >
                    بحث
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================= VUE 3 : CAISSE & CRBT ================= */}
        {activeTab === 'cash' && (
          <div className="space-y-4">
            {/* Big Cash Counter Card */}
            <div className="bg-gradient-to-br from-emerald-950 via-slate-900 to-slate-950 border border-emerald-700/60 rounded-3xl p-5 shadow-xl">
              <div className="flex items-center justify-between pb-3 border-b border-emerald-800/40">
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Wallet className="w-4 h-4 text-emerald-400" />
                  <span>المبلغ الإجمالي المحصل (الصندوق)</span>
                </span>
                <span className="px-2.5 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full text-[10px] font-bold">
                  Cash COD
                </span>
              </div>

              <div className="my-4">
                <div className="text-3xl font-black text-white tracking-tight">
                  {cashStats.collected} <span className="text-base font-bold text-emerald-400">MAD</span>
                </div>
                <p className="text-xs text-slate-300 mt-1">
                  مجموع المبالغ النقدية المحصلة اليوم من الزبائن
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-3 border-t border-emerald-800/40 text-xs">
                <div>
                  <span className="text-[10px] text-slate-400 block">طرود تم تسليمها بنجاح</span>
                  <span className="font-bold text-emerald-400 text-sm">{cashStats.deliveredCount} colis</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">المبلغ المتبقي في الجولة</span>
                  <span className="font-bold text-amber-400 text-sm">{cashStats.pending} MAD</span>
                </div>
              </div>
            </div>

            {/* Cash Actions */}
            <div className="space-y-2">
              <button
                onClick={handleExportCashReport}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/40 transition"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>تحميل كشف الحساب اليومي (Rapport CSV)</span>
              </button>
            </div>

            {/* List of Delivered & Collected Parcels */}
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 space-y-3">
              <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>تفاصيل الشحنات المستخلصة اليوم ({cashStats.deliveredCount})</span>
              </h4>

              <div className="divide-y divide-slate-800 max-h-60 overflow-y-auto">
                {myPackages.filter((p: PackageItem) => p.status === 'livre').length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-4">لم يتم استخلاص أي شحنة بعد اليوم.</p>
                ) : (
                  myPackages
                    .filter((p: PackageItem) => p.status === 'livre')
                    .map((p: PackageItem) => (
                      <div key={p.id} className="py-2.5 flex items-center justify-between text-xs">
                        <div>
                          <span className="font-mono text-[10px] text-slate-400">{p.trackingNumber}</span>
                          <div className="font-bold text-white">{p.recipientName}</div>
                        </div>
                        <div className="text-right">
                          <span className="font-black text-emerald-400">+{p.codAmount} DH</span>
                          <span className="text-[10px] text-slate-500 block font-mono">{p.city}</span>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================= VUE 4 : ITINÉRAIRE & CARTE ================= */}
        {activeTab === 'map' && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-black text-white flex items-center gap-2">
                    <Navigation className="w-4 h-4 text-purple-400" />
                    <span>مسار التوصيل الذكي (Itinéraire)</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    عناوين الزبائن مرتبة حسب الأولوية
                  </p>
                </div>
                <span className="px-2.5 py-1 bg-purple-950 text-purple-300 border border-purple-800/50 rounded-xl text-xs font-bold font-mono">
                  {myPackages.filter((p: PackageItem) => p.status !== 'livre').length} محطات
                </span>
              </div>

              {/* Stops List */}
              <div className="space-y-2.5">
                {myPackages.filter((p: PackageItem) => p.status !== 'livre').map((p: PackageItem, idx: number) => (
                  <div 
                    key={p.id}
                    className="p-3 bg-slate-950/70 border border-slate-800/80 rounded-2xl flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-red-600 text-white font-black text-xs flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>
                      <div>
                        <div className="font-bold text-xs text-white">{p.recipientName}</div>
                        <div className="text-[11px] text-slate-400 truncate max-w-[180px]">{p.address}, {p.city}</div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleOpenGoogleMaps(p.address, p.city)}
                      className="px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold rounded-xl flex items-center gap-1 shrink-0"
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      <span>GPS</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ================= VUE 5 : PROFIL & VÉHICULE ================= */}
        {activeTab === 'profile' && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 space-y-4 text-center">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center text-white mx-auto shadow-xl">
                <Bike className="w-8 h-8" />
              </div>

              <div>
                <h3 className="text-base font-black text-white">{currentUser?.name || 'Mouzawwi3'}</h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">{currentUser?.phone || '+212 600 00 00 00'}</p>
                <span className="inline-block px-3 py-1 bg-red-950/80 text-red-400 border border-red-800/50 rounded-full text-[10px] font-bold mt-2 uppercase">
                  Livreur Officiel FARIOUSY
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-left pt-2 border-t border-slate-800">
                <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[10px] text-slate-400 block font-bold uppercase">المدينة / المنطقة</span>
                  <span className="text-xs font-bold text-white mt-0.5 block">{currentUser?.city || 'Laâyoune'}</span>
                </div>
                <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[10px] text-slate-400 block font-bold uppercase">وسيلة النقل</span>
                  <span className="text-xs font-bold text-white mt-0.5 block">دراجة نارية (Moto)</span>
                </div>
              </div>

              {/* Install PWA Button */}
              <button
                onClick={() => setShowInstallModal(true)}
                className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-2xl text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-red-950/60 transition"
              >
                <Smartphone className="w-4 h-4" />
                <span>تثبيت التطبيق على هاتفي (Install APK)</span>
              </button>

              {/* Logout Button */}
              <button
                onClick={logout}
                className="w-full py-2.5 bg-slate-800 hover:bg-rose-950 text-slate-300 hover:text-rose-400 rounded-2xl text-xs font-bold flex items-center justify-center gap-2 transition"
              >
                <LogOut className="w-4 h-4" />
                <span>تسجيل الخروج من الحساب</span>
              </button>
            </div>

            {/* Driver Customer Reviews Summary */}
            {(() => {
              const myDriverName = (currentUser?.name || '').trim().toLowerCase();
              const myReviews = (reviews || []).filter(
                r =>
                  r.isPublic !== false &&
                  r.targetType === 'driver' &&
                  ((currentUser?.id && r.driverId === currentUser.id) ||
                    (myDriverName && (r.driverName || '').trim().toLowerCase() === myDriverName))
              );
              const avgScore = myReviews.length
                ? myReviews.reduce((s, r) => s + r.rating, 0) / myReviews.length
                : 0;

              return (
                <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-5 space-y-3" dir="rtl">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Star className="w-5 h-5 text-amber-400 fill-amber-400" />
                      <h4 className="text-sm font-black text-white">تقييمات الزبائن لي</h4>
                    </div>
                    <div className="px-2.5 py-1 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-black force-ltr">
                      {myReviews.length ? `${avgScore.toFixed(1)} ★ (${myReviews.length})` : '0 ★'}
                    </div>
                  </div>

                  {myReviews.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-3">
                      لا توجد تقييمات مسجلة لك من الزبائن بعد.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {myReviews.slice(0, 5).map(rev => (
                        <div key={rev.id} className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-white">{rev.authorName}</span>
                            <div className="flex items-center gap-0.5">
                              {[1, 2, 3, 4, 5].map(s => (
                                <Star
                                  key={s}
                                  className={`w-3 h-3 ${
                                    s <= rev.rating ? 'text-amber-400 fill-amber-400' : 'text-slate-700'
                                  }`}
                                />
                              ))}
                            </div>
                          </div>
                          <p className="text-[11px] text-slate-300 leading-relaxed">{rev.comment}</p>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {new Date(rev.createdAt).toLocaleDateString('ar-MA')}
                            {rev.trackingNumber ? ` · ${rev.trackingNumber}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </main>

      {/* ================= 3. BOTTOM MOBILE NAVIGATION BAR ================= */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 px-2 py-2 flex items-center justify-around max-w-lg mx-auto shadow-2xl">
        <button
          onClick={() => setActiveTab('tour')}
          className={`flex-1 py-1.5 flex flex-col items-center gap-1 rounded-xl transition ${
            activeTab === 'tour' ? 'text-red-500 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <PackageCheck className="w-5 h-5" />
          <span className="text-[10px]">الطرود</span>
        </button>

        <button
          onClick={() => setActiveTab('map')}
          className={`flex-1 py-1.5 flex flex-col items-center gap-1 rounded-xl transition ${
            activeTab === 'map' ? 'text-purple-400 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Navigation className="w-5 h-5" />
          <span className="text-[10px]">المسار</span>
        </button>

        {/* Central Big Scanner Button */}
        <button
          onClick={() => {
            setActiveTab('scanner');
            setScannerActive(true);
          }}
          className="relative -top-4 w-13 h-13 rounded-full bg-gradient-to-tr from-red-600 via-rose-600 to-red-500 text-white flex items-center justify-center shadow-xl shadow-red-950/80 active:scale-95 transition cursor-pointer border-4 border-slate-950"
        >
          <QrCode className="w-6 h-6" />
        </button>

        <button
          onClick={() => setActiveTab('cash')}
          className={`flex-1 py-1.5 flex flex-col items-center gap-1 rounded-xl transition ${
            activeTab === 'cash' ? 'text-emerald-400 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Wallet className="w-5 h-5" />
          <span className="text-[10px]">الصندوق</span>
        </button>

        <button
          onClick={() => setActiveTab('profile')}
          className={`flex-1 py-1.5 flex flex-col items-center gap-1 rounded-xl transition ${
            activeTab === 'profile' ? 'text-red-500 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Bike className="w-5 h-5" />
          <span className="text-[10px]">حسابي</span>
        </button>
      </nav>

      {/* ================= 4. DELIVERY ACTION MODAL (MODAL DE LIVRAISON) ================= */}
      {selectedPkg && (
        <div className="fixed inset-0 bg-black/85 z-50 flex items-end sm:items-center justify-center p-3 sm:p-4 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-5 space-y-4 max-h-[92vh] overflow-y-auto animate-in slide-in-from-bottom-6">
            {/* Modal Header */}
            <div className="flex justify-between items-start pb-3 border-b border-slate-800">
              <div>
                <span className="text-[10px] font-mono font-bold text-red-400 bg-red-950/80 px-2 py-0.5 rounded border border-red-800/40">
                  {selectedPkg.trackingNumber}
                </span>
                <h3 className="font-black text-white text-base mt-1.5">{selectedPkg.recipientName}</h3>
                <p className="text-xs text-slate-400">{selectedPkg.recipientPhone} • {selectedPkg.city}</p>
              </div>

              <div className="text-right flex flex-col items-end">
                <span className="text-[10px] text-slate-400 block font-bold">المبلغ المستحق</span>
                <span className="text-lg font-black text-emerald-400">{selectedPkg.codAmount} DH</span>
                <div className="flex items-center gap-1.5 mt-1">
                  <button
                    type="button"
                    onClick={() => setTicketPkg(selectedPkg)}
                    className="px-2 py-1 text-[11px] font-bold text-red-400 bg-red-950/60 hover:bg-red-900 border border-red-800/40 rounded-lg flex items-center gap-1 transition cursor-pointer"
                  >
                    <Printer className="w-3 h-3" />
                    <span>تيكي</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPkg(null)}
                    className="p-1 text-slate-400 hover:text-white rounded-lg bg-slate-800 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* 1. Status Selection Grid */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-300 block">
                1. حدد الحالة الجديدة للشحنة *
              </label>
              <div className="grid grid-cols-2 gap-2">
                {DRIVER_STATUS_OPTIONS.map(opt => {
                  const Icon = opt.icon;
                  const isSelected = selectedStatus === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSelectedStatus(opt.value)}
                      className={`p-3 rounded-2xl text-left border transition flex items-start gap-2.5 cursor-pointer ${
                        isSelected 
                          ? `${opt.color} border-white/20 shadow-lg scale-101` 
                          : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <span className="text-xs font-bold block leading-tight">{opt.label}</span>
                        <span className="text-[10px] opacity-80 block mt-0.5">{opt.labelAr}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Specific Fields based on Status */}
            {selectedStatus === 'livre' && (
              <div className="space-y-2 bg-slate-950/70 p-3.5 rounded-2xl border border-emerald-800/40">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>توقيع الزبون على الشاشة (اختياري)</span>
                  </span>
                  {hasSignature && (
                    <button
                      type="button"
                      onClick={clearSignature}
                      className="text-[10px] text-rose-400 hover:underline flex items-center gap-1"
                    >
                      <Eraser className="w-3 h-3" />
                      <span>مسح التوقيع</span>
                    </button>
                  )}
                </div>

                <div className="bg-white rounded-xl overflow-hidden touch-none border border-slate-300">
                  <canvas
                    ref={canvasRef}
                    width={340}
                    height={110}
                    onMouseDown={startDrawing}
                    onMouseUp={stopDrawing}
                    onMouseMove={draw}
                    onTouchStart={startDrawing}
                    onTouchEnd={stopDrawing}
                    onTouchMove={draw}
                    className="w-full h-[110px] cursor-crosshair"
                  />
                </div>
                <p className="text-[10px] text-slate-400 text-center">وقع بإصبعك داخل الإطار الأبيض</p>
              </div>
            )}

            {selectedStatus === 'reporte' && (
              <div className="space-y-1.5 bg-slate-950/70 p-3 rounded-2xl border border-blue-800/40">
                <label className="text-xs font-bold text-blue-300 block">تاريخ التأجيل المطلوب :</label>
                <input
                  type="date"
                  value={postponedDate}
                  onChange={e => setPostponedDate(e.target.value)}
                  className="w-full p-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white"
                />
              </div>
            )}

            {selectedStatus === 'refuse' && (
              <div className="space-y-1.5 bg-slate-950/70 p-3 rounded-2xl border border-rose-800/40">
                <label className="text-xs font-bold text-rose-300 block">سبب رفض الشحنة :</label>
                <select
                  value={refusalReason}
                  onChange={e => setRefusalReason(e.target.value)}
                  className="w-full p-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white"
                >
                  <option value="Client a changé d'avis">الزبون غير رأيه</option>
                  <option value="Prix trop élevé / Erreur montant">السعر مرتفع / خطأ في الثمن</option>
                  <option value="Produit non conforme à la commande">المنتوج لا يطابق الطلب</option>
                  <option value="Colis endommagé">الشحنة مكسورة أو متضررة</option>
                  <option value="Autre raison">سبب آخر</option>
                </select>
              </div>
            )}

            {selectedStatus === 'probleme_livraison' && (
              <div className="space-y-3 bg-red-950/35 p-3.5 rounded-2xl border border-red-700/60">
                <div>
                  <span className="text-xs font-bold text-red-300 flex items-center gap-1.5 mb-2">
                    <AlertTriangle className="w-4 h-4 text-red-400" />
                    <span>نوع المشكلة في التوصيل *</span>
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {PROBLEM_CATEGORIES.map(cat => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setProblemCategory(cat.id)}
                        className={`px-2.5 py-2 rounded-xl text-[11px] font-bold text-right border transition cursor-pointer ${
                          problemCategory === cat.id
                            ? 'bg-red-600 text-white border-red-400 shadow-xs'
                            : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800'
                        }`}
                      >
                        {cat.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-red-200 flex items-center gap-1.5">
                      <Camera className="w-3.5 h-3.5 text-red-400" />
                      <span>تصوير المشكلة (يشوفها المدير مباشرة)</span>
                    </span>
                    {callProofBase64 && (
                      <button
                        type="button"
                        onClick={() => setCallProofBase64(null)}
                        className="text-[10px] text-rose-300 hover:underline cursor-pointer"
                      >
                        حذف الصورة
                      </button>
                    )}
                  </div>

                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    ref={fileInputRef}
                    onChange={handleProofImageUpload}
                    className="hidden"
                  />

                  {callProofBase64 ? (
                    <div className="relative rounded-xl overflow-hidden border border-emerald-500/60 bg-black">
                      <img src={callProofBase64} alt="صورة المشكلة" className="max-h-40 w-full object-contain mx-auto" />
                      <span className="absolute bottom-1.5 right-2 bg-emerald-950/90 text-emerald-300 text-[10px] px-2 py-0.5 rounded font-bold">
                        ✓ تم التقاط الصورة وستصل للمدير
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full py-3.5 border-2 border-dashed border-red-600/60 hover:border-red-400 rounded-xl bg-slate-900/70 flex flex-col items-center justify-center gap-1 text-red-200 cursor-pointer transition"
                    >
                      <Camera className="w-5 h-5 text-red-400" />
                      <span className="text-xs font-bold">📸 صور المشكلة بالكاميرا أو اختر صورة</span>
                      <span className="text-[10px] text-slate-400">تضغط تلقائياً وتظهر فوراً عند المدير</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {selectedStatus === 'pas_de_reponse' && (
              <div className="space-y-2 bg-slate-950/70 p-3 rounded-2xl border border-amber-800/40">
                <div
                  dir="rtl"
                  className="no-translate text-[11px] font-bold text-amber-200 bg-amber-950/60 border border-amber-700/50 rounded-xl px-3 py-2 flex items-center gap-2"
                >
                  <PhoneCall className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>ضرورة الاتصال بالزبون 3 مرات على الأقل مع ضرورة احترام الزبون.</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                    <PhoneCall className="w-3.5 h-3.5 text-amber-400" />
                    <span>إثبات الاتصال (كابتور شاشة سجل المكالمات)</span>
                  </span>
                  {callProofBase64 && (
                    <button
                      type="button"
                      onClick={() => setCallProofBase64(null)}
                      className="text-[10px] text-rose-400 hover:underline"
                    >
                      حذف
                    </button>
                  )}
                </div>

                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  ref={fileInputRef}
                  onChange={handleProofImageUpload}
                  className="hidden"
                />

                {callProofBase64 ? (
                  <div className="relative rounded-xl overflow-hidden border border-emerald-500/50 bg-black">
                    <img src={callProofBase64} alt="Preuve" className="max-h-28 w-full object-contain mx-auto" />
                    <span className="absolute bottom-1 right-2 bg-emerald-950/90 text-emerald-300 text-[10px] px-2 py-0.5 rounded font-mono">
                      ✓ صورة محملة
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-2.5 border border-dashed border-slate-700 hover:border-slate-500 rounded-xl bg-slate-900/50 flex flex-col items-center justify-center gap-1 text-slate-400"
                  >
                    <Camera className="w-4 h-4 text-slate-400" />
                    <span className="text-[11px] font-semibold">التقاط أو رفع صورة من سجل المكالمات</span>
                  </button>
                )}
              </div>
            )}

            {/* 3. Driver Note / Comment */}
            <div>
              <label className="text-xs font-bold text-slate-300 mb-1 flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5 text-slate-400" />
                <span>ملاحظة أو تعليق الموزع :</span>
              </label>
              <textarea
                rows={2}
                placeholder="أضف أي تفاصيل مهمة حول التسليم..."
                value={driverComment}
                onChange={e => setDriverComment(e.target.value)}
                className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500"
              />
            </div>

            {/* Actions Buttons */}
            <div className="pt-2 flex gap-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setSelectedPkg(null)}
                className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleSaveStatusWithProof}
                className="flex-1 py-3 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl text-xs font-black shadow-lg shadow-red-950/60 transition flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {isSubmitting ? (
                  <span>جاري التسجيل...</span>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>تأكيد وحفظ التغيير</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 5. PWA / APK INSTALL MODAL ================= */}
      <PWAInstallModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
      />

      {/* ================= 6. THERMAL TICKET PRINT MODAL ================= */}
      <ThermalLabelModal
        packageItem={ticketPkg}
        isOpen={!!ticketPkg}
        onClose={() => setTicketPkg(null)}
      />
    </div>
  );
};