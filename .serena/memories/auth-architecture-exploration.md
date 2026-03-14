# Authentication & Middleware Architecture - Comprehensive Exploration

## Executive Summary
This ERP system uses **Clerk for authentication** (Clerk users, sessions, roles via public metadata) with **custom Prisma database models** for granular permissions. NO custom User model exists - Clerk is the source of truth for user identity. The system supports both **admin-portal** and **customer-portal** apps with independent middleware but shared API/tRPC layer.

---

## 1. CLERK MIDDLEWARE SETUP

### Admin Portal Middleware
**File:** `/Users/kyseah/Documents/GitHub/joho-erp/apps/admin-portal/middleware.ts`

Architecture:
- **E2E Testing Support**: Bypasses Clerk auth entirely when `E2E_TESTING=true && NODE_ENV !== 'production'`
- **Public Routes**: Home, sign-in, sign-up, cron endpoints
- **i18n + Clerk Chain**: Applies internationalization FIRST, then auth protection
- **Auth Protection**: Uses `await auth.protect()` for non-public routes
- **Bypass Routes**: API, tRPC, Clerk internal routes bypass i18n processing

Public routes pattern (both admin and customer):
```
'/', '/:locale/(auth)', '/:locale/sign-in', '/:locale/sign-up'
```

Customer portal adds: `'/:locale/onboarding(.*)'` as semi-public (requires Clerk but not customer registration)

### Key Middleware Features
- **Order**: Clerk auth → i18n routing → response
- **Auth Check**: Protects all routes except public routes
- **No Custom Session Management**: Relies entirely on Clerk's middleware

---

## 2. DATABASE USER MODEL - NONE EXISTS

### Important Discovery
**NO User model in the Prisma schema!**

Instead:
- Clerk stores user identity, basic profile (firstName, lastName, email, imageUrl, banned status)
- Clerk stores user role in `publicMetadata` as `{ role: UserRole }`
- Database stores only **role-to-permission mappings** (not user-specific)

Models related to users:
- `Permission` - Define what actions are allowed (module:action codes)
- `RolePermission` - Map roles to permissions (admin, sales, manager, packer, driver, customer)
- `AuditLog` - Track who did what (userId is Clerk ID, captured with username/email)

No way to store custom "user status" (active/inactive/suspended) beyond Clerk's `banned` flag.

---

## 3. tRPC CONTEXT & AUTH INTEGRATION

### Context Creation Flow
**Files:** 
- `/Users/kyseah/Documents/GitHub/joho-erp/packages/api/src/context.ts` - Context definition
- `/Users/kyseah/Documents/GitHub/joho-erp/apps/admin-portal/app/api/trpc/[trpc]/route.ts` - Admin portal tRPC handler
- `/Users/kyseah/Documents/GitHub/joho-erp/apps/customer-portal/app/api/trpc/[trpc]/route.ts` - Customer portal tRPC handler

#### Context Shape
```typescript
interface CreateContextOptions {
  auth: {
    userId: string | null;        // Clerk user ID
    sessionId: string | null;      // Clerk session ID
    userRole?: UserRole | null;    // Role from Clerk publicMetadata
    userName?: string | null;      // Display name (firstName + lastName)
  };
}
```

#### How userId is Populated
1. **In middleware**: `await auth()` returns `{ userId, sessionId, ... }`
2. **In tRPC route handler**: 
   - Admin: E2E testing can override with headers (`x-e2e-user-id`, `x-e2e-user-role`)
   - Production: Calls `await auth()` inside createContext
3. **Fetches user metadata**: Uses `await clerkClient().users.getUser(userId)`
4. **Extracts role**: From `user.publicMetadata.role` (defaults to 'customer')
5. **Extracts name**: From `firstName + lastName` or email

#### Both portals share same pattern
Admin portal has additional E2E bypass for testing.

---

## 4. tRPC PROTECTED PROCEDURES & RBAC

### Base Procedures
**File:** `/Users/kyseah/Documents/GitHub/joho-erp/packages/api/src/trpc.ts`

#### publicProcedure
- No auth required
- Usage: Public endpoints, signup, etc.

#### protectedProcedure
- Requires `ctx.userId` to be non-null
- Throws `UNAUTHORIZED` if missing
- Returns context with guaranteed userId

#### hasRole(allowedRoles)
- Middleware factory for role-based access
- Admin role always bypasses (superuser)
- Default role: 'customer' if not in Clerk metadata
- Throws `FORBIDDEN` with generic message for enum protection

Pre-configured role middlewares:
- `isAdmin` - admin only
- `isAdminOrSales` - admin + sales
- `isAdminOrSalesOrManager` - admin + sales + manager
- `isPacker` - packer + admin
- `isDriver` - driver + admin

### Permission-Based Access Control (NEW)
#### requirePermission(permission)
- Checks database for role → permission mapping
- Admin bypasses all checks
- Throws `FORBIDDEN` with generic message

#### requireAnyPermission(permissions[])
- User needs at least one permission from array

#### requireAllPermissions(permissions[])
- User needs all permissions from array

---

## 5. USER MANAGEMENT ENDPOINTS

### File
`/Users/kyseah/Documents/GitHub/joho-erp/packages/api/src/routers/user.ts`

#### User Response Interface
```typescript
interface UserResponse {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  status: 'active' | 'invited' | 'banned';
  lastSignInAt: Date | null;
  createdAt: Date;
  imageUrl: string | null;
}
```

Note: `status` is mapped from Clerk's `user.banned` boolean.

#### Key Endpoints

**getAll** - List all internal users (non-customers)
- Requires: `settings.users:view` permission
- Returns: All users with admin/sales/manager/packer/driver roles

**getById(userId)** - Get specific user
- Requires: `settings.users:view` permission

**updateRole(userId, role)** - Change user role
- Requires: `settings.users:edit` permission
- Prevents: User from removing their own admin role
- Action: Updates `user.publicMetadata.role` in Clerk
- Audit: Logs role change with `logUserRoleChange()`

**deactivate(userId, deactivate: boolean)** - Ban/unban user
- Requires: `settings.users:delete` permission
- Prevents: User from deactivating themselves
- Action: Calls `clerkClient().users.banUser()` or `unbanUser()`
- Audit: Logs status change with `logUserStatusChange()`
- **This is the built-in deactivation mechanism!**

**invite(email, firstName, lastName, role)** - Invite new internal user
- Requires: `settings.users:create` permission
- Action: Creates Clerk invitation with role in publicMetadata
- Audit: Logs with `logUserInvitation()`

**getPendingInvitations()** - List pending invites
- Requires: `settings.users:view` permission

**revokeInvitation(invitationId)** - Cancel pending invite
- Requires: `settings.users:delete` permission
- Audit: Logs with `logInvitationRevoke()`

**getMyProfile()** - Current user's profile
- Requires: Authentication only
- Returns: Mapped current user data

---

## 6. EXISTING SESSION MANAGEMENT

### What EXISTS
- **Clerk.banUser()** - Deactivates user in Clerk (prevents future logins)
- **Clerk.unbanUser()** - Reactivates user
- **clerkClient.signOut()** - Frontend uses `useClerk().signOut()` to sign out (example in admin-mobile-drawer.tsx)
- **No explicit session revocation** - Clerk sessions remain active after ban until they naturally expire or client signs out

### What DOESN'T Exist
- **No custom session revocation** - Can't immediately revoke active Clerk sessions
- **No immediate logout of banned users** - Banned users with active sessions can still make API calls until session expires
- **No database User model** - Can't store custom status beyond Clerk's ban flag

### How deactivate.mutation Works TODAY
1. Calls `clerkClient.users.banUser(userId)` - Sets Clerk user.banned = true
2. Logs audit entry: `logUserStatusChange(..., { action: 'deactivate' })`
3. Returns updated user with `status: 'banned'`

Problem: User's existing session still works! They can continue using API until session naturally expires.

---

## 7. AUDIT LOGGING SYSTEM

### File
`/Users/kyseah/Documents/GitHub/joho-erp/packages/api/src/services/audit.ts`

### Core Audit Model
**Database:** `AuditLog` table

Fields:
```
id, userId, userEmail, userRole, userName, action, entity, entityId, 
changes (JSON), metadata (JSON), ipAddress, userAgent, timestamp
```

Actions: `create`, `update`, `delete`, `approve`, `reject`

### User-Specific Audit Functions

#### logUserStatusChange()
```typescript
logUserStatusChange(
  userId,
  userEmail,
  userRole,
  userName,
  targetUserId,
  { targetUserEmail, action: 'deactivate' | 'activate' }
)
```
Stores:
- change: field='status', oldValue='active'/'inactive', newValue='inactive'/'active'
- metadata.type = 'deactivate' or 'activate'
- metadata.targetUserEmail

#### logUserRoleChange()
Similar pattern - tracks role changes with before/after values.

#### logUserInvitation() & logInvitationRevoke()
Track invitation lifecycle.

### Critical Detail
Audit logs capture:
- WHO made the change (userId, userEmail, userRole, userName)
- WHAT changed (entity=user, action=update, field=status)
- WHEN it happened (timestamp)
- WHY potentially (metadata with action details)

**But do NOT prevent concurrent API calls from deactivated users!**

---

## 8. CUSTOMER PORTAL AUTH

### File
`/Users/kyseah/Documents/GitHub/joho-erp/apps/customer-portal/middleware.ts`

**Differences from admin portal:**
- No E2E testing bypass
- Adds `'/:locale/onboarding(.*)'` as semi-public route
- Otherwise identical middleware structure

### Same tRPC Context Creation
Uses same pattern as admin portal (no E2E bypass).

**Key insight:** Both portals hit same `/api/trpc` endpoints, but middleware routes differently. This means:
- Admin and customer portal share the same API
- Permissions/roles must distinguish between them
- Both can manage users via shared API

---

## 9. PERMISSION & ROLE SYSTEM

### Models
**Permission**
- `id`, `module`, `action`, `code` (unique), `description`, `isActive`
- Example codes: `settings.users:view`, `settings.users:edit`, `settings.users:delete`

**RolePermission**
- Maps `role` to `permissionId`
- Tracks `grantedAt`, `grantedBy` (who granted it)
- Composite unique: (role, permissionId)

### Permission Service
**File:** `/Users/kyseah/Documents/GitHub/joho-erp/packages/api/src/services/permission-service.ts`

Features:
- **Admin always has all permissions** - No database check needed
- **Permission caching**: 5-minute TTL for role permissions
- **Methods**: `hasPermission()`, `hasAnyPermission()`, `hasAllPermissions()`
- **Cache clearing**: Called when permissions change

### Built-in Role Hierarchy
- **admin**: All permissions (hardcoded)
- **sales**: Customer management, orders, pricing, deliveries
- **manager**: Similar to sales + analytics
- **packer**: Warehouse/packing operations
- **driver**: Delivery operations
- **customer**: Limited to own data (default)

---

## 10. KEY FINDINGS FOR USER DEACTIVATION FEATURE

### Current State
✅ **Partial deactivation exists** via `user.deactivate()` endpoint:
- Uses Clerk's `banUser()` API
- Prevents NEW logins (banned users can't sign in)
- Logs status change to AuditLog
- BUT does NOT revoke active sessions

### Gaps for Custom Deactivation
❌ **No way to:**
- Store custom deactivation reason or date in database (no User model)
- Prevent API calls from deactivated users with valid sessions
- Immediately terminate existing sessions
- Distinguish between "invited but not accepted" vs "active then deactivated"
- Reactivate customer accounts (only internal users can be unbanned)

### Clerk Limitations
- banUser() only prevents new logins
- No official API to revoke existing sessions
- Sessions expire naturally or on client signOut()
- publicMetadata can store custom flags (e.g., deactivationReason, deactivatedAt)

### Safe Deactivation Architecture Needed
1. Ban user in Clerk (`banUser()`)
2. Store deactivation metadata in custom publicMetadata
3. Add middleware/context check: if user is banned, reject API calls
4. Add endpoint to revoke all user sessions via Clerk admin API
5. Create database table to track deactivation history (since no User model)

---

## 11. TECHNICAL STACK SUMMARY

**Authentication:**
- Clerk (managed service for auth)
- Clerk sessions (JWT-based, server-side verification)

**Authorization:**
- tRPC middleware (role/permission checks)
- Permission database (fine-grained access control)
- Role hierarchy (role-based defaults)

**Database:**
- MongoDB via Prisma
- NO User model (Clerk is source of truth)
- Permission/RolePermission for RBAC
- AuditLog for compliance

**Frontend Auth:**
- Clerk middleware catches unauthenticated users
- tRPC context provides userId/userRole
- useClerk() hook for signOut
- Client-side permission checks possible with context

---

## 12. FILES & PATHS SUMMARY

### Core Auth Files
- Middleware: `apps/{admin,customer}-portal/middleware.ts`
- tRPC Handler: `apps/{admin,customer}-portal/app/api/trpc/[trpc]/route.ts`
- Context: `packages/api/src/context.ts`
- tRPC Setup: `packages/api/src/trpc.ts`
- User Router: `packages/api/src/routers/user.ts`
- Audit Service: `packages/api/src/services/audit.ts`
- Permission Service: `packages/api/src/services/permission-service.ts`

### Database Schema
- Prisma Schema: `packages/database/prisma/schema.prisma`
- Generated Client: `packages/database/src/generated/prisma`

### Types & Constants
- UserRole type: Defined in `packages/api/src/context.ts`
- AuditAction enum: In Prisma schema
- Permission codes: In `@joho-erp/shared`

---

## Recommendations for Safe User Deactivation

1. **Use existing Clerk banUser()** for immediate login prevention
2. **Add custom publicMetadata** for deactivation reason and timestamp
3. **Add context-level check** to reject all API calls from banned users
4. **Create AuditLog-like table** for deactivation history (outside Clerk)
5. **Consider session revocation** via Clerk Admin API if available
6. **Prevent self-deactivation** (already enforced)
7. **Add audit trail** (already implemented via logUserStatusChange)
8. **Test concurrent requests** during deactivation window
