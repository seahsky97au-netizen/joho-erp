/**
 * Backfill Customer Coordinates
 *
 * One-shot script to backfill latitude/longitude on customers whose
 * deliveryAddress.latitude or deliveryAddress.longitude is null, missing, or 0.
 *
 * Geocoding pipeline mirrors packages/api/src/routers/customer.ts geocodeAddressCoordinates:
 *   1. Try Mapbox v6 geocoding (requires NEXT_PUBLIC_MAPBOX_TOKEN).
 *   2. Fall back to SuburbAreaMapping (Melbourne metro only at time of writing).
 *   3. If both fail, skip the record and log it as needs-manual-attention.
 *
 * Usage:
 *   pnpm --filter @joho-erp/database backfill:coords          # dry-run
 *   pnpm --filter @joho-erp/database backfill:coords:apply    # actually update DB
 */

import { PrismaClient } from '../generated/prisma';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient({ log: ['error', 'warn'] });

const isApply = process.argv.includes('--apply');
const isDryRun = !isApply;

interface AddressInput {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
}

async function geocodeAddressCoordinates(
  address: AddressInput
): Promise<{ latitude: number | null; longitude: number | null; source: 'mapbox' | 'suburbMapping' | 'none' }> {
  let latitude: number | null = null;
  let longitude: number | null = null;
  let source: 'mapbox' | 'suburbMapping' | 'none' = 'none';

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (mapboxToken) {
    try {
      const fullAddress = `${address.street}, ${address.suburb}, ${address.state} ${address.postcode}, Australia`;
      const encodedAddress = encodeURIComponent(fullAddress);
      const geocodeUrl = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodedAddress}&access_token=${mapboxToken}&country=AU&limit=1&types=address,secondary_address`;

      const geocodeResponse = await fetch(geocodeUrl);
      if (geocodeResponse.ok) {
        const geocodeData = await geocodeResponse.json();
        if (geocodeData.features && geocodeData.features.length > 0) {
          const feature = geocodeData.features[0];
          latitude = feature.properties.coordinates.latitude;
          longitude = feature.properties.coordinates.longitude;
          source = 'mapbox';
        }
      }
    } catch (geocodeError) {
      console.warn(`  Mapbox geocoding failed: ${(geocodeError as Error).message}`);
    }
  }

  if (latitude === null || longitude === null) {
    const suburbMapping = await prisma.suburbAreaMapping.findFirst({
      where: {
        suburb: { equals: address.suburb, mode: 'insensitive' },
        state: address.state,
        isActive: true,
      },
    });
    if (suburbMapping) {
      latitude = suburbMapping.latitude;
      longitude = suburbMapping.longitude;
      source = 'suburbMapping';
    }
  }

  return { latitude, longitude, source };
}

async function main() {
  console.log('='.repeat(80));
  console.log(`CUSTOMER COORDINATE BACKFILL ${isDryRun ? '(DRY RUN)' : '(APPLYING)'}`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('='.repeat(80));

  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    console.error('\n❌ NEXT_PUBLIC_MAPBOX_TOKEN is not set. Mapbox geocoding will be skipped.');
    console.error('   Only customers with suburbs in SuburbAreaMapping will be backfilled.');
  }

  // Customer.deliveryAddress is a composite type. Prisma cannot filter on inner null fields
  // for embedded composites, so we fetch all customers and filter in-memory.
  const allCustomers = await prisma.customer.findMany({
    select: {
      id: true,
      businessName: true,
      deliveryAddress: true,
    },
  });

  const affected = allCustomers.filter((c) => {
    const lat = c.deliveryAddress?.latitude;
    const lng = c.deliveryAddress?.longitude;
    return !lat || !lng || lat === 0 || lng === 0;
  });

  console.log(`\nScanned ${allCustomers.length} customers; ${affected.length} are missing coordinates.\n`);

  if (affected.length === 0) {
    console.log('✅ Nothing to backfill.');
    return;
  }

  let geocoded = 0;
  let needsManual = 0;
  const manualList: Array<{ id: string; businessName: string; address: string }> = [];

  for (const customer of affected) {
    const addr = customer.deliveryAddress;
    if (!addr || !addr.street || !addr.suburb || !addr.state || !addr.postcode) {
      console.log(`⚠️  ${customer.businessName} (${customer.id}): incomplete address, skipping`);
      needsManual++;
      manualList.push({
        id: customer.id,
        businessName: customer.businessName,
        address: '(incomplete)',
      });
      continue;
    }

    const fullAddr = `${addr.street}, ${addr.suburb}, ${addr.state} ${addr.postcode}`;
    process.stdout.write(`→ ${customer.businessName} — ${fullAddr} ... `);

    try {
      const coords = await geocodeAddressCoordinates({
        street: addr.street,
        suburb: addr.suburb,
        state: addr.state,
        postcode: addr.postcode,
      });

      if (!coords.latitude || !coords.longitude) {
        console.log('NO MATCH');
        needsManual++;
        manualList.push({ id: customer.id, businessName: customer.businessName, address: fullAddr });
        continue;
      }

      console.log(
        `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)} (${coords.source})${isDryRun ? ' [dry-run]' : ''}`
      );

      if (!isDryRun) {
        await prisma.customer.update({
          where: { id: customer.id },
          data: {
            deliveryAddress: {
              ...addr,
              latitude: coords.latitude,
              longitude: coords.longitude,
            },
          },
        });
      }

      geocoded++;
    } catch (error) {
      console.log(`ERROR: ${(error as Error).message}`);
      needsManual++;
      manualList.push({ id: customer.id, businessName: customer.businessName, address: fullAddr });
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Scanned:                ${allCustomers.length}`);
  console.log(`Affected (no coords):   ${affected.length}`);
  console.log(`Geocoded${isDryRun ? ' (would be)' : ''}:  ${geocoded}`);
  console.log(`Needs manual fix:       ${needsManual}`);

  if (manualList.length > 0) {
    console.log('\nCustomers needing manual attention:');
    for (const m of manualList) {
      console.log(`  - ${m.businessName} (${m.id}) — ${m.address}`);
    }
  }

  if (isDryRun && affected.length > 0) {
    console.log('\n👉 Re-run with --apply to persist changes.');
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
