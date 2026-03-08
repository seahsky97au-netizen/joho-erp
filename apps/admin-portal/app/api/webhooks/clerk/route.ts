import { Webhook } from 'svix';
import { headers } from 'next/headers';
import { WebhookEvent } from '@clerk/nextjs/server';
import { clerkClient } from '@clerk/nextjs/server';
import { prisma } from '@joho-erp/database';

export async function POST(req: Request) {
  // 1. Get webhook secret
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    console.error('Missing CLERK_WEBHOOK_SECRET environment variable');
    return new Response('Missing webhook secret', { status: 500 });
  }

  // 2. Get headers for verification
  const headerPayload = await headers();
  const svix_id = headerPayload.get('svix-id');
  const svix_timestamp = headerPayload.get('svix-timestamp');
  const svix_signature = headerPayload.get('svix-signature');

  if (!svix_id || !svix_timestamp || !svix_signature) {
    console.error('Missing svix headers');
    return new Response('Missing svix headers', { status: 400 });
  }

  // 3. Verify webhook
  const payload = await req.json();
  const body = JSON.stringify(payload);
  const wh = new Webhook(WEBHOOK_SECRET);
  let evt: WebhookEvent;

  try {
    evt = wh.verify(body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as WebhookEvent;
  } catch (err) {
    console.error('Invalid webhook signature:', err);
    return new Response('Invalid signature', { status: 400 });
  }

  // 4. Handle user.created event
  if (evt.type === 'user.created') {
    const { id: userId, email_addresses } = evt.data;
    const primaryEmail = email_addresses?.find(
      (e) => e.id === evt.data.primary_email_address_id
    );

    if (primaryEmail) {
      try {
        const client = await clerkClient();

        // Find pending invitation by email
        const invitations = await client.invitations.getInvitationList({
          status: 'pending',
        });

        const invitation = invitations.data.find(
          (inv) => inv.emailAddress === primaryEmail.email_address
        );

        if (invitation?.publicMetadata) {
          const metadata = invitation.publicMetadata as {
            role?: string;
            customerId?: string;
          };

          console.log(
            `Transferring metadata from invitation to user ${userId}:`,
            metadata
          );

          // Transfer metadata from invitation to user
          await client.users.updateUserMetadata(userId, {
            publicMetadata: metadata,
          });

          // If this is a customer invitation, link the customer record
          if (metadata.role === 'customer' && metadata.customerId) {
            try {
              await prisma.customer.update({
                where: { id: metadata.customerId },
                data: {
                  clerkUserId: userId,
                  portalInvitationStatus: 'accepted',
                },
              });
              console.log(
                `Linked customer ${metadata.customerId} to Clerk user ${userId}`
              );
            } catch (dbError) {
              console.error(
                `Failed to link customer ${metadata.customerId} to user ${userId}:`,
                dbError
              );
            }
          }

          // Revoke the invitation since it's been used
          await client.invitations.revokeInvitation(invitation.id);

          console.log(
            `Successfully transferred invitation metadata to user ${userId}`
          );
        } else {
          console.log(
            `No pending invitation found for email: ${primaryEmail.email_address}`
          );
        }
      } catch (error) {
        console.error('Error processing user.created webhook:', error);
        // Return 200 to prevent webhook retries for application errors
        return new Response('Error processing webhook', { status: 200 });
      }
    }
  }

  return new Response('OK', { status: 200 });
}
