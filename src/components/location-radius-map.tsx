"use client";

import dynamic from "next/dynamic";

const MapInner = dynamic(() => import("./location-radius-map-inner"), {
  ssr: false,
  loading: () => (
    <div className="h-[220px] rounded-xl bg-slate-100 flex items-center justify-center">
      <span className="text-xs text-slate-400">Loading map…</span>
    </div>
  ),
});

interface Props {
  lat: number;
  lng: number;
  radiusKm: number;
  onCenterChange?: (lat: number, lng: number) => void;
}

export function LocationRadiusMap({ lat, lng, radiusKm, onCenterChange }: Props) {
  return <MapInner lat={lat} lng={lng} radiusKm={radiusKm} onCenterChange={onCenterChange} />;
}
