'use client';

import { Check, AlertCircle, MapPin } from 'lucide-react';
import { getStatusColor, getStatusSize, getStatusRingColor } from './marker-styles';

interface DeliveryMarkerProps {
  status: string;
  sequence?: number | null;
  isPriority?: boolean;
  areaColor?: string | null;
  onClick?: () => void;
}

export function DeliveryMarker({
  status,
  sequence,
  isPriority = false,
  areaColor,
  onClick,
}: DeliveryMarkerProps) {
  const statusColor = getStatusColor(status);
  const color = areaColor || statusColor;
  const borderColor = areaColor ? getStatusRingColor(status) : 'white';
  const size = getStatusSize(status);
  const isCompleted = status === 'delivered';
  const isActive = status === 'ready_for_delivery';

  // If no sequence, use simple pin marker
  if (!sequence) {
    return (
      <div
        className="cursor-pointer transform hover:scale-125 transition-all duration-200"
        onClick={onClick}
      >
        <MapPin
          className="drop-shadow-2xl"
          style={{ color }}
          size={32}
          fill="currentColor"
        />
      </div>
    );
  }

  return (
    <div
      className="cursor-pointer transform hover:scale-125 transition-all duration-200 relative"
      onClick={onClick}
    >
      {/* Priority indicator */}
      {isPriority && !isCompleted && (
        <div className="absolute -top-1 -right-1 z-20">
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center shadow-lg border-2 border-white animate-pulse"
            style={{
              backgroundColor: '#EF4444',
            }}
          >
            <AlertCircle className="text-white" size={12} strokeWidth={3} />
          </div>
        </div>
      )}

      {/* Pulsing ring for active deliveries */}
      {isActive && (
        <div
          className="absolute inset-0 rounded-full animate-ping"
          style={{
            backgroundColor: color,
            opacity: 0.3,
            width: `${size}px`,
            height: `${size}px`,
            top: 0,
            left: 0,
          }}
        />
      )}

      {/* Main marker body */}
      <div className="relative">
        {/* Outer status ring */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            width: `${size}px`,
            height: `${size}px`,
            background: `linear-gradient(135deg, ${color}dd, ${color}aa)`,
            boxShadow: `0 8px 20px -4px ${color}80, 0 4px 8px -2px ${color}60`,
          }}
        />

        {/* Inner circle with sequence number or checkmark */}
        <div
          className="relative rounded-full flex items-center justify-center font-bold text-white border-4 shadow-inner"
          style={{
            backgroundColor: color,
            borderColor,
            width: `${size}px`,
            height: `${size}px`,
            fontSize: isCompleted ? '12px' : '16px',
          }}
        >
          {isCompleted ? (
            <Check size={18} strokeWidth={3} />
          ) : (
            <span className="relative z-10">{sequence}</span>
          )}
        </div>

        {/* Arrow pointer */}
        <div
          className="absolute left-1/2 transform -translate-x-1/2"
          style={{
            bottom: '-6px',
            width: 0,
            height: 0,
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: `6px solid ${color}`,
          }}
        />
      </div>
    </div>
  );
}
