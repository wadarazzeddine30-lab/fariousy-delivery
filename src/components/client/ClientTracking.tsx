import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useDatabase } from '../../context/DatabaseContext';
import { PackageItem } from '../../types';
import { formatMAD, formatDate, getStatusBadgeColor, getStatusLabel } from '../../utils/barcode';
import {
  Search,
  Package,
  Clock,
  MapPin,
  Phone,
  CheckCircle2,
  Calendar,
  AlertCircle,
  Truck,
  ArrowRight,
  User,
  ShieldCheck,
  Eye
} from 'lucide-react';

interface ClientTrackingProps {
  onViewPackage: (pkg: PackageItem) => void;
}

export const ClientTracking: React.FC<ClientTrackingProps> = ({ onViewPackage }) => {
  const { currentUser } = useAuth();
  const { packages } = useDatabase();

  const myShopId = (currentUser as any)?.shopId;
  const myPackages = packages.filter(
    p =>
      p.clientId === currentUser?.id ||
      (Boolean(p.shopId) && (p.shopId === currentUser?.id || (Boolean(myShopId) && p.shopId === myShopId))) ||
      (Boolean(myShopId) && p.clientId === myShopId)
  );

  const [searchTracking, setSearchTracking] = useState('');
  const [selectedPackage, setSelectedPackage] = useState<PackageItem | null>(
    myPackages[0] || null
  );

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = searchTracking.trim().toUpperCase();
    if (!clean) return;

    const found = myPackages.find(
      p =>
        p.trackingNumber.toUpperCase().includes(clean) ||
        p.id.toUpperCase().includes(clean) ||
        p.recipientPhone.includes(clean) ||
        p.recipientName.toLowerCase().includes(clean.toLowerCase())
    );

    if (found) {
      setSelectedPackage(found);
    } else {
      alert(`Aucun colis trouvé correspondant à "${searchTracking}" dans vos expéditions.`);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h2 className="text-xl font-black text-slate-900 tracking-tight">
            Suivi des Colis en Temps Réel
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Localisation, historique des étapes d'acheminement et statut de vos expéditions
          </p>
        </div>

        <div className="text-xs font-mono bg-white border border-slate-200 px-3 py-1.5 rounded-xl font-bold text-slate-700">
          Total Expédiés : <strong className="text-red-600">{myPackages.length}</strong>
        </div>
      </div>

      {/* Search Bar */}
      <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-2xs">
        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchTracking}
              onChange={e => setSearchTracking(e.target.value)}
              placeholder="Rechercher par N° de suivi (ex: FAR-2601-8491), nom ou téléphone du destinataire..."
              className="w-full pl-9 pr-4 py-2.5 text-xs bg-slate-50 border border-slate-300 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-mono"
            />
          </div>
          <button
            type="submit"
            className="px-5 py-2.5 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-xl shadow-xs transition-colors shrink-0"
          >
            Rechercher le Colis
          </button>
        </form>
      </div>

      {/* Main Grid: Package List + Tracking Detail Card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Quick select recent packages */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            Mes Derniers Colis ({myPackages.length})
          </h3>

          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {myPackages.map(pkg => {
              const isSelected = selectedPackage?.id === pkg.id;
              return (
                <div
                  key={pkg.id}
                  onClick={() => setSelectedPackage(pkg)}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-red-50/60 border-red-300 shadow-xs'
                      : 'bg-white border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono font-bold text-xs text-slate-900">
                      {pkg.trackingNumber}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getStatusBadgeColor(
                        pkg.status
                      )}`}
                    >
                      {getStatusLabel(pkg.status)}
                    </span>
                  </div>

                  <div className="text-xs text-slate-700 font-medium truncate">
                    {pkg.recipientName}
                  </div>

                  <div className="flex items-center justify-between mt-2 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3 text-slate-400" />
                      <span>{pkg.city}</span>
                    </span>
                    <span className="font-mono font-bold text-slate-900">
                      {formatMAD(pkg.codAmount)}
                    </span>
                  </div>
                </div>
              );
            })}

            {myPackages.length === 0 && (
              <div className="p-8 text-center bg-white border border-slate-200 rounded-2xl text-xs text-slate-400">
                Vous n'avez pas encore créé de colis.
              </div>
            )}
          </div>
        </div>

        {/* Right: Detailed Package Timeline & Overview */}
        <div className="lg:col-span-2">
          {selectedPackage ? (
            <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs overflow-hidden space-y-6 p-6">
              {/* Header Info */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-black text-lg text-slate-900">
                      {selectedPackage.trackingNumber}
                    </span>
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-black uppercase tracking-wider ${getStatusBadgeColor(
                        selectedPackage.status
                      )}`}
                    >
                      {getStatusLabel(selectedPackage.status)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Créé le {selectedPackage.createdAt} • ID : {selectedPackage.id}
                  </p>
                </div>

                <button
                  onClick={() => onViewPackage(selectedPackage)}
                  className="px-3.5 py-2 text-xs font-bold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors flex items-center gap-1.5 self-start sm:self-auto"
                >
                  <Eye className="w-4 h-4 text-slate-600" />
                  <span>Voir Fiche Complète</span>
                </button>
              </div>

              {/* Coordinates Overview */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-2">
                  <div className="flex items-center gap-2 text-slate-900 font-bold">
                    <User className="w-4 h-4 text-red-600" />
                    <span>Destinataire du Colis</span>
                  </div>
                  <div className="text-slate-800 font-semibold">{selectedPackage.recipientName}</div>
                  <div className="text-slate-600 font-mono flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5 text-slate-400" />
                    <span>{selectedPackage.recipientPhone}</span>
                  </div>
                  <div className="text-slate-600 flex items-start gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                    <span>
                      {selectedPackage.city} — {selectedPackage.address}
                    </span>
                  </div>
                </div>

                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-2">
                  <div className="flex items-center gap-2 text-slate-900 font-bold">
                    <Package className="w-4 h-4 text-slate-700" />
                    <span>Détails & Finance</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Marchandise :</span>
                    <strong className="text-slate-900">{selectedPackage.description}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Montant CRBT / COD :</span>
                    <strong className="text-slate-900 font-mono text-sm">
                      {formatMAD(selectedPackage.codAmount)}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Frais de livraison :</span>
                    <span className="text-red-600 font-mono font-bold">
                      {formatMAD(selectedPackage.deliveryFee)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Net commerçant :</span>
                    <span className="text-emerald-700 font-mono font-black">
                      {formatMAD(selectedPackage.codAmount - selectedPackage.deliveryFee)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Timeline of events */}
              <div>
                <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-red-600" />
                  <span>Historique des Mouvements & Suivi d'Étape</span>
                </h4>

                <div className="relative pl-6 border-l-2 border-slate-200 space-y-6 text-xs">
                  {selectedPackage.history?.map((step, idx) => (
                    <div key={idx} className="relative">
                      {/* Timeline dot */}
                      <span
                        className={`absolute -left-[31px] top-0.5 w-4 h-4 rounded-full border-2 border-white shadow-xs ${
                          idx === selectedPackage.history.length - 1
                            ? 'bg-red-600 ring-4 ring-red-100'
                            : 'bg-slate-400'
                        }`}
                      />

                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900">{step.statusLabel || step.status}</span>
                        <span className="font-mono text-[11px] text-slate-400">
                          {formatDate(step.timestamp)}
                        </span>
                      </div>

                      <p className="text-slate-600 mt-1">{step.comment || 'Étape validée par le système.'}</p>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        Intervenant : {step.updatedBy} • Lieu : {step.location}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-12 text-center bg-white border border-slate-200 rounded-2xl text-xs text-slate-400">
              Sélectionnez un colis pour afficher son suivi détaillé.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
