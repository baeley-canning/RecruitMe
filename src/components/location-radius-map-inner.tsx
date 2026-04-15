"use client";

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Circle, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix default marker icons broken by webpack
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

function Recenter({ lat, lng, zoom }: { lat: number; lng: number; zoom: number }) {
  const map = useMap();
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current) {
      map.setView([lat, lng], zoom);
      didInit.current = true;
    }
  }, [lat, lng, zoom, map]);
  return null;
}

// Fires onMove when the user clicks the map (moves the epicenter)
function ClickToMove({ onMove }: { onMove?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMove?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

interface Props {
  lat: number;
  lng: number;
  radiusKm: number;
  onCenterChange?: (lat: number, lng: number) => void;
}

export default function LocationRadiusMapInner({ lat, lng, radiusKm, onCenterChange }: Props) {
  const zoom = radiusKm <= 15 ? 12 : radiusKm <= 40 ? 10 : radiusKm <= 80 ? 9 : 8;

  const draggableIcon = L.divIcon({
    className: "",
    html: `<div style="
      width:22px;height:22px;border-radius:50%;
      background:#3b82f6;border:3px solid white;
      box-shadow:0 1px 6px rgba(0,0,0,0.35);
      cursor:grab;
    "></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

  return (
    <div style={{ position: "relative" }}>
      {onCenterChange && (
        <div style={{
          position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
          zIndex: 1000, background: "rgba(255,255,255,0.9)", borderRadius: 8,
          padding: "2px 10px", fontSize: 11, color: "#475569", pointerEvents: "none",
          boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
        }}>
          Click map to move centre
        </div>
      )}
      <MapContainer
        center={[lat, lng]}
        zoom={zoom}
        style={{ height: "220px", width: "100%", borderRadius: "12px" }}
        scrollWheelZoom={false}
        zoomControl={true}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Circle
          center={[lat, lng]}
          radius={radiusKm * 1000}
          pathOptions={{
            color: "#3b82f6",
            fillColor: "#3b82f6",
            fillOpacity: 0.15,
            weight: 2.5,
          }}
        />
        <Marker
          position={[lat, lng]}
          icon={draggableIcon}
          draggable={!!onCenterChange}
          eventHandlers={{
            dragend(e) {
              const m = e.target as L.Marker;
              const { lat: newLat, lng: newLng } = m.getLatLng();
              onCenterChange?.(newLat, newLng);
            },
          }}
        />
        {onCenterChange && <ClickToMove onMove={onCenterChange} />}
        <Recenter lat={lat} lng={lng} zoom={zoom} />
      </MapContainer>
    </div>
  );
}
