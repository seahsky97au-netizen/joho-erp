'use client';

import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/nextjs';

export function AmplitudeProvider({ children }: { children: React.ReactNode }) {
  const initializedRef = useRef(false);
  const { userId } = useAuth();

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY;
    if (!apiKey || initializedRef.current) return;

    async function init() {
      const amplitude = await import('@amplitude/unified');
      amplitude.initAll(apiKey!, {
        analytics: { autocapture: true },
        sessionReplay: { sampleRate: 1 },
      });
      initializedRef.current = true;
    }

    init();
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;

    async function identify() {
      const amplitude = await import('@amplitude/unified');
      amplitude.setUserId(userId ?? undefined);
    }

    identify();
  }, [userId]);

  return <>{children}</>;
}
