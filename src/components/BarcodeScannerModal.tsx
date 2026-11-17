import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, ChevronRight, PackageCheck, Scan, Truck, Warehouse, X, AlertCircle, Boxes } from 'lucide-react';
import { useDatabase } from '../context/DatabaseContext';
import { useAuth } from '../context/AuthContext';
import { ClientStockProduct, ClientStockUnit, PackageItem } from '../types';
import { formatMAD } from '../utils/barcode';

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultAction?: 'reception_stock' | 'depart_livraison' | 'arrivee_agence' | 'marquer_livre' | 'marquer_retour';
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  defaultAction = 'reception_stock'
}) => {
  const {
    packages,
    users,
    scanBarcodeAction,
    clientStockProducts,
    scanClientStockUnit,
    dispatchClientStockUnit
  } = useDatabase();
  const { currentUser } = useAuth();

  const [inputCode, setInputCode] = useState('');
  const [selectedAction, setSelectedAction] = useState<'reception_stock' | 'depart_livraison' | 'arrivee_agence' | 'marquer_livre' | 'marquer_retour'>(defaultAction);
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [lastScannedResult, setLastScannedResult] = useState<{
    success: boolean;
    message: string;
    pkg?: PackageItem;
    stockProduct?: ClientStockProduct;
    stockUnit?: ClientStockUnit;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const drivers = users.filter(u => u.role === 'driver');

  useEffect(() => {
    if (drivers.length > 0 && !selectedDriverId) {
      setSelectedDriverId(drivers[0].id);
    }
  }, [drivers, selectedDriverId]);

  // Handle camera start/stop
  useEffect(() => {
    if (isOpen && cameraActive) {
      navigator.mediaDevices
        ?.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
          }
        })
        .catch(err => {
          console.warn('Camera error:', err);
          setCameraError("Impossible d'accéder à la caméra. Utilisez la saisie par douchette ci-dessous.");
          setCameraActive(false);
        });
    }

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, [isOpen, cameraActive]);

  if (!isOpen) return null;

  const handleExecuteScan = async (codeToScan: string) => {
    const clean = codeToScan.trim().toUpperCase();
    if (!clean) return;

    // 1. Check if code matches a Client Stock Unit (FSU-...) or Product SKU (SKU-...)
    const isStockCode =
      clean.startsWith('FSU-') ||
      clean.startsWith('SKU-') ||
      clientStockProducts.some(
        p => p.skuCode.toUpperCase() === clean || p.units.some(u => u.unitCode.toUpperCase() === clean)
      );

    if (isStockCode) {
      const isExitAction = selectedAction === 'depart_livraison' || selectedAction === 'marquer_livre';
      const stockRes = isExitAction
        ? await dispatchClientStockUnit(clean, {
            actorName: currentUser?.name || 'Entrepôt',
            notes:
              selectedAction === 'depart_livraison'
                ? 'إخراج تلقائي عبر سكان الشحن (Départ livraison)'
                : 'إخراج تلقائي عبر سكان التسليم (Livré)'
          })
        : await scanClientStockUnit(clean, {
            hubName: currentUser?.city || 'Hub Central Casablanca',
            actorName: currentUser?.name || 'Entrepôt'
          });
      setLastScannedResult({
        success: stockRes.success,
        message: stockRes.message,
        stockProduct: stockRes.product,
        stockUnit: stockRes.unit
      });
      setInputCode('');
      return;
    }

    const driver = drivers.find(d => d.id === selectedDriverId);

    const res = scanBarcodeAction(
      codeToScan,
      selectedAction,
      {
        driverId: selectedDriverId,
        driverName: driver?.name,
        location: currentUser?.city || 'Hub Central Casablanca'
      },
      currentUser ? { name: currentUser.name, role: currentUser.role } : undefined
    );

    setLastScannedResult({
      success: res.success,
      message: res.message,
      pkg: res.packageItem
    });

    setInputCode('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleExecuteScan(inputCode);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs no-print">
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center">
              <Scan className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Scanner Code-barres & Colis</h3>
              <p className="text-xs text-slate-500">Douchette rapide, caméra ou recherche directe</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action Type Selector */}
        <div className="p-4 border-b border-slate-100 bg-white">
          <label className="block text-xs font-semibold text-slate-600 mb-2">Opération à exécuter lors du scan :</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setSelectedAction('reception_stock')}
              className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-semibold border transition-all text-left ${
                selectedAction === 'reception_stock'
                  ? 'border-red-600 bg-red-50/70 text-red-700'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Warehouse className="w-4 h-4 shrink-0 text-red-600" />
              <span>Entrée en Stock Hub</span>
            </button>

            <button
              type="button"
              onClick={() => setSelectedAction('depart_livraison')}
              className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-semibold border transition-all text-left ${
                selectedAction === 'depart_livraison'
                  ? 'border-red-600 bg-red-50/70 text-red-700'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Truck className="w-4 h-4 shrink-0 text-red-600" />
              <span>Chargement Livreur</span>
            </button>

            <button
              type="button"
              onClick={() => setSelectedAction('marquer_livre')}
              className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-semibold border transition-all text-left ${
                selectedAction === 'marquer_livre'
                  ? 'border-red-600 bg-red-50/70 text-red-700'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <PackageCheck className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>Valider Livraison</span>
            </button>

            <button
              type="button"
              onClick={() => setSelectedAction('arrivee_agence')}
              className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-semibold border transition-all text-left ${
                selectedAction === 'arrivee_agence'
                  ? 'border-red-600 bg-red-50/70 text-red-700'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Warehouse className="w-4 h-4 shrink-0 text-blue-600" />
              <span>Arrivée Destination</span>
            </button>

            <button
              type="button"
              onClick={() => setSelectedAction('marquer_retour')}
              className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-semibold border transition-all text-left ${
                selectedAction === 'marquer_retour'
                  ? 'border-red-600 bg-red-50/70 text-red-700'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>Réception Retour</span>
            </button>
          </div>

          {selectedAction === 'depart_livraison' && (
            <div className="mt-3 p-3 bg-amber-50/60 border border-amber-200 rounded-xl">
              <label className="block text-xs font-bold text-amber-900 mb-1">
                Livreur assigné pour la tournée :
              </label>
              <select
                value={selectedDriverId}
                onChange={e => setSelectedDriverId(e.target.value)}
                className="w-full text-xs font-medium bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                {drivers.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.city} - {d.driverVehicle || 'Véhicule'})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Scanner Feed / Douchette Input */}
        <div className="p-6 overflow-y-auto space-y-4">
          {/* Camera toggle bar */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-600">Scan par caméra mobile / webcam :</span>
            <button
              type="button"
              onClick={() => {
                setCameraActive(!cameraActive);
                setCameraError(null);
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                cameraActive
                  ? 'bg-rose-100 text-rose-700 hover:bg-rose-200'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              {cameraActive ? 'Arrêter la caméra' : 'Activer la caméra'}
            </button>
          </div>

          {cameraError && (
            <div className="p-3 text-xs bg-amber-50 text-amber-800 rounded-xl border border-amber-200">
              {cameraError}
            </div>
          )}

          {cameraActive && (
            <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden flex items-center justify-center">
              <video ref={videoRef} className="w-full h-full object-cover" />
              {/* Scan target reticle overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-56 h-28 border-2 border-red-500 rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.5)] flex flex-col justify-between p-1">
                  <div className="w-full h-0.5 bg-red-500/80 animate-pulse" />
                  <span className="text-[10px] text-white text-center font-mono bg-black/60 px-1 py-0.5 rounded-sm">
                    Placez le code-barres ici
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Douchette Form */}
          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block text-xs font-bold text-slate-700">
              Numéro de suivi (Douchette USB/Bluetooth ou saisie manuelle) :
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={inputCode}
                  onChange={e => setInputCode(e.target.value)}
                  placeholder="Ex: FAR-2601-8491 ou code-barres"
                  autoFocus
                  className="w-full px-4 py-3 text-sm font-mono font-semibold bg-slate-50 border border-slate-300 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>
              <button
                type="submit"
                className="px-5 py-3 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shrink-0 shadow-xs flex items-center gap-2"
              >
                <span>Valider le scan</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </form>

          {/* Quick scan simulator chips */}
          <div className="pt-2">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">
              Colis disponibles pour test de scan rapide en 1 clic :
            </span>
            <div className="flex flex-wrap gap-1.5">
              {packages.slice(0, 5).map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleExecuteScan(p.trackingNumber)}
                  className="px-2.5 py-1 text-xs font-mono bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md border border-slate-200 transition-colors"
                >
                  {p.trackingNumber} ({p.city})
                </button>
              ))}
            </div>
          </div>

          {/* Scan Result Feedback Banner */}
          {lastScannedResult && (
            <div
              className={`p-4 rounded-xl border flex items-start gap-3 transition-all ${
                lastScannedResult.success
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-rose-50 border-rose-200 text-rose-900'
              }`}
            >
              {lastScannedResult.success ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 text-xs">
                <p className="font-bold text-sm">{lastScannedResult.message}</p>
                {lastScannedResult.pkg && (
                  <div className="mt-2 pt-2 border-t border-emerald-200 grid grid-cols-2 gap-2 text-slate-700">
                    <div>
                      <span className="text-[10px] text-slate-500 block">Destinataire:</span>
                      <span className="font-semibold">{lastScannedResult.pkg.recipientName} ({lastScannedResult.pkg.city})</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">Montant CRBT:</span>
                      <span className="font-mono font-bold text-slate-900">{formatMAD(lastScannedResult.pkg.codAmount)}</span>
                    </div>
                  </div>
                )}
                {lastScannedResult.stockProduct && (
                  <div className="mt-2 pt-2 border-t border-emerald-200 flex items-center gap-3 text-slate-700">
                    {lastScannedResult.stockProduct.photoUrl ? (
                      <img
                        src={lastScannedResult.stockProduct.photoUrl}
                        alt={lastScannedResult.stockProduct.name}
                        className="w-12 h-12 rounded-lg object-cover border border-slate-200 shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                        <Boxes className="w-6 h-6 text-slate-400" />
                      </div>
                    )}
                    <div className="text-xs space-y-0.5">
                      <div className="font-black text-slate-900">{lastScannedResult.stockProduct.name}</div>
                      <div className="text-[11px] text-slate-600">
                        {lastScannedResult.stockProduct.clientCompany || lastScannedResult.stockProduct.clientName}
                        {lastScannedResult.stockUnit ? ` · ${lastScannedResult.stockUnit.unitCode}` : ''}
                      </div>
                      <div className="text-[11px] font-bold text-emerald-700">
                        متوفر فالسطوك: {lastScannedResult.stockProduct.units.filter(u => u.status === 'en_stock').length} / {lastScannedResult.stockProduct.units.length}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <span>Compatible avec toutes les douchettes laser et terminaux Android PDA</span>
          <button
            onClick={onClose}
            className="px-4 py-2 font-medium text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};
