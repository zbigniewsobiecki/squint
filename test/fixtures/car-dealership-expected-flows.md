# Car-Dealership: Expected Flow Output (Ground Truth)

This document describes the 5 most important e2e flows we expect squint to detect
for the `car-dealership` repository. It serves as a verification reference after
running a full ingest (`interactions generate --force && flows generate --force`).

## Architecture Summary

**Monorepo**: pnpm workspace with `apps/frontend` (React 18 + Vite) and `apps/backend` (Express + PostgreSQL).

**Cross-boundary communication**: HTTP REST API. Frontend services use axios to
call backend controllers. squint's contract matcher should detect these as
`contract-matched` interactions via matching HTTP method + path pairs.

**Frontend data flow**: Page → Hook → Service → HTTP (contract bridge) → Backend
**Backend data flow**: Controller → Service → Repository/Model → PostgreSQL

---

## Expected Module Structure (approximate)

Module names are LLM-generated and may vary, but the *grouping* should reflect:

| Logical Group | Key Definitions | Expected Module Count |
|---|---|---|
| Frontend pages | Login, Dashboard, Vehicles, Customers, Sales | 1-5 modules |
| Frontend hooks | useVehicles, useCustomers, useSales, useRepairs, useVehicleFilters + related | 1-4 modules |
| Frontend services | vehiclesService, customersService, salesService, authService, repairsService | 1-5 modules |
| Frontend components | VehicleForm, VehicleCard, CustomerForm, SaleForm, Layout, etc. | 1-4 modules |
| Frontend store/auth | authStore, ProtectedRoute | 1-2 modules |
| Backend controllers | AuthController, VehiclesController, CustomersController, SalesController, RepairsController, ReportsController, HealthController, BaseController | 1-8 modules |
| Backend services | AuthService, VehiclesService, CustomersService, SalesService, RepairsService, BaseService | 1-6 modules |
| Backend models | UserModel, VehicleRepository, CustomerRepository, SaleRepository, RepairRepository, BaseRepository | 1-5 modules |
| Backend middleware | authenticateToken, errorHandler, validation | 1-2 modules |
| Backend config/utils | database pool, env config, jwt utils, password utils, dataMapper, queryBuilder, asyncHandler | 1-4 modules |
| Shared types | Entity types, enums, API types | 1-3 modules |

**Total expected modules**: 50-120 (depends on deepening threshold)

---

## Expected Contract-Matched Interactions

These are the HTTP contracts squint should detect. Each produces a `contract-matched`
interaction linking a frontend service module to a backend controller module.

| Contract (HTTP) | Frontend Initiator | Backend Handler |
|---|---|---|
| `POST /api/auth/login` | `authService.login()` | `authController.login` |
| `GET /api/auth/me` | `authService.getMe()` | `authController.getMe` |
| `GET /api/vehicles` | `vehiclesService.getAll()` | `vehiclesController.getAll` |
| `GET /api/vehicles/stats` | `vehiclesService.getStats()` | `vehiclesController.getStats` |
| `GET /api/vehicles/recent` | `vehiclesService.getRecent()` | `vehiclesController.getRecent` |
| `GET /api/vehicles/:id` | `vehiclesService.getById()` | `vehiclesController.getById` |
| `POST /api/vehicles` | `vehiclesService.create()` | `vehiclesController.create` |
| `PUT /api/vehicles/:id` | `vehiclesService.update()` | `vehiclesController.update` |
| `DELETE /api/vehicles/:id` | `vehiclesService.delete()` | `vehiclesController.delete` |
| `GET /api/customers` | `customersService.getAll()` | `customersController.getAll` |
| `GET /api/customers/:id` | `customersService.getById()` | `customersController.getById` |
| `POST /api/customers` | `customersService.create()` | `customersController.create` |
| `PUT /api/customers/:id` | `customersService.update()` | `customersController.update` |
| `DELETE /api/customers/:id` | `customersService.delete()` | `customersController.delete` |
| `GET /api/customers/:id/sales` | `customersService.getSales()` | `customersController.getSales` |
| `GET /api/sales` | `salesService.getAll()` | `salesController.getAll` |
| `GET /api/sales/stats` | `salesService.getStats()` | `salesController.getStats` |
| `GET /api/sales/stats/monthly` | `salesService.getMonthlyStats()` | `salesController.getMonthlyStats` |
| `GET /api/sales/:id` | `salesService.getById()` | `salesController.getById` |
| `POST /api/sales` | `salesService.create()` | `salesController.create` |
| `PUT /api/sales/:id` | `salesService.update()` | `salesController.update` |
| `DELETE /api/sales/:id` | `salesService.delete()` | `salesController.delete` |
| `GET /api/repairs` | `repairsService.getAll()` | `repairsController.getAll` |
| `GET /api/repairs/:id` | `repairsService.getById()` | `repairsController.getById` |
| `POST /api/repairs` | `repairsService.create()` | `repairsController.create` |
| `PATCH /api/repairs/:id` | `repairsService.update()` | `repairsController.update` |
| `DELETE /api/repairs/:id` | `repairsService.delete()` | `repairsController.delete` |
| `POST /api/auth/refresh` | `api.ts` interceptor | `authController.refresh` |

**Unmatched contracts** (backend-only, no frontend caller):

| Contract (HTTP) | Backend Handler | Notes |
|---|---|---|
| `POST /api/auth/register` | `authController.register` | Registration endpoint, no frontend sign-up page |
| `GET /api/reports/revenue` | `reportsController.getRevenue` | Admin-only revenue report |
| `GET /health` | `healthController.check` | Health check (mounted at `/health`, not `/api/health`) |

**Expected**: ~28 matched contracts collapsing into 4-8 `contract-matched`
interactions (one per frontend-service ↔ backend-controller module pair), plus
~3-6 unmatched contracts (backend-only endpoints with no frontend caller).

**After the contract_id PK fix**: `interaction_definition_links` should have one
row per contract, so ~28 definition link rows even if some interactions are
shared between module pairs.

---

## The 5 Most Important E2E Flows

### Flow 1: User Login

**Why it matters**: Authentication gates every other feature. Involves cross-boundary
auth token exchange, state persistence, and the full frontend→backend→DB read path.

**Expected entry point**: Login page module, member `Login` (the page component).

**Action**: This is a form submission (mutation), not a page view. The LLM may
classify it as `actionType: 'process'` or `actionType: 'create'` (creating a session).

**Expected definition-level trace**:
```
Login (page component)
  → authService.login()                    [frontend service - makes POST call]
  ──── contract bridge: POST /api/auth/login ────
  → authController.login                   [backend controller]
    → authService.login()                  [backend service - verifies credentials]
      → userModel.findByEmail()            [backend model - DB lookup]
      → passwordUtils.compare()            [utility - bcrypt verification]
      → jwtUtils.sign()                    [utility - JWT access token]
      → jwtUtils.signRefreshToken()        [utility - JWT refresh token]
```

**Expected module-level interactions** (minimum):
1. Login page module → Frontend auth service module (AST call graph)
2. Frontend auth service → Backend auth controller module (contract-matched bridge)
3. Backend auth controller → Backend auth service (AST call graph)
4. Backend auth service → Backend user model (AST call graph)
5. Backend auth service → Backend utility module (jwt/password) (AST call graph)

**Verification queries**:
```sql
-- Flow should exist with login-related name
SELECT * FROM flows WHERE slug LIKE '%login%' OR (action_type IS NOT NULL AND target_entity LIKE '%auth%');

-- Should have >=3 flow steps (interactions crossed)
SELECT COUNT(*) FROM flow_steps WHERE flow_id = <login_flow_id>;

-- Should have definition steps crossing the HTTP boundary
SELECT fds.*, fd.name as from_name, td.name as to_name
FROM flow_definition_steps fds
JOIN definitions fd ON fds.from_definition_id = fd.id
JOIN definitions td ON fds.to_definition_id = td.id
WHERE fds.flow_id = <login_flow_id>;
```

**Note**: Login.tsx calls `authService.login()` directly (not through a hook), and
also calls `authStore.login()` to persist the token. The flow tracer should trace
through the service call to the backend.

---

### Flow 2: View Dashboard

**Why it matters**: Aggregates data from multiple backend endpoints. Demonstrates a
read-heavy flow that fans out to multiple services. This is the default landing page
after login.

**Expected entry point**: Dashboard page module, member `Dashboard`.

**Action**: `actionType: 'view'`, `targetEntity: 'dashboard'` (or similar).

**Expected definition-level trace** (view traces the full component tree):
```
Dashboard (page component)
  → useVehicleStats()                       [vehicles hook]
    → vehiclesService.getStats()            [vehicles service]
    ──── contract bridge: GET /api/vehicles/stats ────
    → vehiclesController.getStats           [backend controller]
      → vehiclesService.getStats()          [backend service]
        → vehicleRepository.getStats()      [backend model - aggregation query]
  → useSalesStats()                         [sales hook]
    → salesService.getStats()               [sales service]
    ──── contract bridge: GET /api/sales/stats ────
    → salesController.getStats              [backend controller]
      → salesService.getStats()             [backend service]
        → saleRepository.getStats()         [backend model]
  → useRecentVehicles(5)                    [vehicles hook]
    → vehiclesService.getRecent()           [vehicles service]
    ──── contract bridge: GET /api/vehicles/recent ────
    → vehiclesController.getRecent          [backend controller]
      → vehiclesService.getRecent()         [backend service]
        → vehicleRepository.findRecent()    [backend model]
```

**Expected module-level interactions** (minimum):
1. Dashboard page → Vehicles hooks module (AST)
2. Dashboard page → Sales hooks module (AST)
3. Vehicles hooks → Vehicles service module (AST)
4. Sales hooks → Sales service module (AST)
5. Vehicles service → Backend vehicles controller (contract-matched)
6. Sales service → Backend sales controller (contract-matched)
7. Backend vehicles controller → Backend vehicles service (AST)
8. Backend sales controller → Backend sales service (AST)
9. Backend vehicles service → Vehicle repository (AST)
10. Backend sales service → Sale repository (AST)

**Key verification**: This flow should have the MOST interactions of any single
flow because it fans out to 3 different backend endpoints across 2 entities.

**Verification queries**:
```sql
-- Flow should exist
SELECT * FROM flows WHERE slug LIKE '%dashboard%'
   OR (action_type = 'view' AND target_entity LIKE '%dashboard%');

-- Should have many flow steps (5+ interactions)
SELECT COUNT(*) FROM flow_steps WHERE flow_id = <dashboard_flow_id>;

-- Should cross both vehicles AND sales contract boundaries
SELECT fds.*, fd.name as from_name, td.name as to_name
FROM flow_definition_steps fds
JOIN definitions fd ON fds.from_definition_id = fd.id
JOIN definitions td ON fds.to_definition_id = td.id
WHERE fds.flow_id = <dashboard_flow_id>
ORDER BY fds.step_order;
```

**Caveats**: If hooks and services are in the same module (squint may group
`useVehicleStats` and `vehiclesService.getStats` together), some intermediate steps
may collapse. The critical thing is that the flow crosses the HTTP boundary to BOTH
vehicle and sales backends.

---

### Flow 3: Create Vehicle

**Why it matters**: Core write operation demonstrating the full frontend→backend→DB
mutation path. Includes VIN uniqueness validation as backend business logic.

**Expected entry point**: Vehicles page module, member `Vehicles` (the page component).

**Action**: `actionType: 'create'`, `targetEntity: 'vehicle'`.
**traceFromDefinition**: `useCreateVehicle` (narrows trace to the create mutation path).

**Expected definition-level trace**:
```
Vehicles (page component)
  → useCreateVehicle()                      [vehicles hook - mutation]
    → vehiclesService.create()              [vehicles service - POST call]
    ──── contract bridge: POST /api/vehicles ────
    → vehiclesController.create             [backend controller]
      → vehiclesService.create()            [backend service]
        → vehicleRepository.findByVin()     [VIN uniqueness check]
        → vehicleRepository.create()        [insert into DB]
```

**Expected module-level interactions** (minimum):
1. Vehicles page → Vehicles hooks module (AST)
2. Vehicles hooks → Vehicles service module (AST)
3. Vehicles service → Backend vehicles controller (contract-matched)
4. Backend vehicles controller → Backend vehicles service (AST)
5. Backend vehicles service → Vehicle repository (AST)

**Key verification**: Because `traceFromDefinition` is set to `useCreateVehicle`,
this flow should NOT include the `useVehicles` (list) or `useDeleteVehicle` paths.
It should be narrowly scoped to the create mutation chain.

**Verification queries**:
```sql
-- Flow with create+vehicle
SELECT * FROM flows WHERE action_type = 'create' AND target_entity = 'vehicle';

-- Definition steps should include the VIN check and create
SELECT fds.*, fd.name as from_name, td.name as to_name
FROM flow_definition_steps fds
JOIN definitions fd ON fds.from_definition_id = fd.id
JOIN definitions td ON fds.to_definition_id = td.id
WHERE fds.flow_id = <create_vehicle_flow_id>
ORDER BY fds.step_order;
```

---

### Flow 4: Create Sale (with vehicle status side-effect)

**Why it matters**: Most complex business logic in the app. Creating a sale
triggers validation of both vehicle and customer existence, and when the sale's
`status=COMPLETED`, a side-effect changes the vehicle's status to `SOLD`. This
cross-entity mutation is the most interesting behavior to trace. On the frontend
side, `useCreateSale()` invalidates both `sales` and `vehicles` query caches,
reflecting the cross-entity impact.

**Expected entry point**: Sales page module, member `Sales` (the page component).

**Action**: `actionType: 'create'`, `targetEntity: 'sale'`.
**traceFromDefinition**: `useCreateSale` (narrows trace to the create path).

**Expected definition-level trace**:
```
Sales (page component)
  → useCreateSale()                         [sales hook - mutation]
    → salesService.create()                 [sales service - POST call]
    ──── contract bridge: POST /api/sales ────
    → salesController.create                [backend controller]
      → salesService.create()               [backend service - business logic]
        → vehicleRepository.findById()      [verify vehicle exists]
        → customerRepository.findById()     [verify customer exists]
        → saleRepository.create()           [insert sale record]
        → vehicleRepository.update()        [set vehicle status → SOLD, conditional on sale.status === COMPLETED]
```

**Expected module-level interactions** (minimum):
1. Sales page → Sales hooks module (AST)
2. Sales hooks → Sales service module (AST)
3. Sales service → Backend sales controller (contract-matched)
4. Backend sales controller → Backend sales service (AST)
5. Backend sales service → Sale repository (AST)
6. Backend sales service → Vehicle repository (AST) — **cross-entity side-effect**

**Key verification**: The critical signal is interaction #6: the backend sales
service module should have an interaction edge to the vehicle repository module,
reflecting the cross-entity `vehicleRepository.update()` call that sets status to
SOLD. This is the most important business logic in the app.

**Verification queries**:
```sql
-- Flow with create+sale
SELECT * FROM flows WHERE action_type = 'create' AND target_entity = 'sale';

-- Definition steps should cross into vehicle repository
SELECT fds.*, fd.name as from_name, td.name as to_name
FROM flow_definition_steps fds
JOIN definitions fd ON fds.from_definition_id = fd.id
JOIN definitions td ON fds.to_definition_id = td.id
WHERE fds.flow_id = <create_sale_flow_id>
ORDER BY fds.step_order;

-- Check that the sales service has an interaction to the vehicle model module
SELECT i.*, fm.full_path as from_path, tm.full_path as to_path
FROM interactions i
JOIN modules fm ON i.from_module_id = fm.id
JOIN modules tm ON i.to_module_id = tm.id
WHERE fm.full_path LIKE '%sale%service%'
  AND tm.full_path LIKE '%vehicle%';
```

**Caveats**: Whether squint detects the `vehicleRepository.update()` call from
within `salesService.create()` depends on:
1. The call graph capturing that `SalesService` imports and calls methods on
   `VehicleRepository` (or `VehicleModel`)
2. These being in different modules

If the backend service and model are in the same module, the cross-entity call
won't appear as a separate interaction. The module split is critical here.

---

### Flow 5: Manage Customers (View + CRUD)

**Why it matters**: Demonstrates the standard CRUD pattern that repeats across
entities. Includes soft-delete behavior — `CustomerModel` is constructed with
`softDelete: true`, so the inherited `BaseRepository.delete()` sets `deleted_at`
instead of removing the row (a separate `hardDelete()` method exists for
permanent deletion). This flow can serve as the baseline for verifying all CRUD
entity flows work correctly.

**Expected entry point**: Customers page module, member `Customers`.

#### 5a: View Customers
**Action**: `actionType: 'view'`, `targetEntity: 'customer'`.

**Expected definition-level trace** (view traces full component tree):
```
Customers (page component)
  → useCustomers()                          [customers hook - query]
    → customersService.getAll()             [customers service - GET call]
    ──── contract bridge: GET /api/customers ────
    → customersController.getAll            [backend controller]
      → customersService.getAll()           [backend service — inherited from BaseService]
        → customerRepository.findAll()      [backend model - DB query]
  → useCreateCustomer()                     [also visible in view trace]
    → customersService.create()
    ...
  → useUpdateCustomer()
    → customersService.update()
    ...
  → useDeleteCustomer()
    → customersService.delete()
    ...
```

#### 5b: Create Customer
**Action**: `actionType: 'create'`, `targetEntity: 'customer'`.
**traceFromDefinition**: `useCreateCustomer`.

```
Customers (page component)
  → useCreateCustomer()                     [customers hook - mutation]
    → customersService.create()             [customers service - POST call]
    ──── contract bridge: POST /api/customers ────
    → customersController.create            [backend controller]
      → customersService.create()           [backend service]
        → customerRepository.create()       [backend model - insert]
```

#### 5c: Delete Customer
**Action**: `actionType: 'delete'`, `targetEntity: 'customer'`.
**traceFromDefinition**: `useDeleteCustomer`.

```
Customers (page component)
  → useDeleteCustomer()                     [customers hook - mutation]
    → customersService.delete()             [customers service - DELETE call]
    ──── contract bridge: DELETE /api/customers/:id ────
    → customersController.delete            [backend controller]
      → customersService.delete()           [backend service - soft delete logic]
        → customerRepository.delete()       [backend model - soft deletes via BaseRepository (softDelete: true config)]
```

**Expected module-level interactions** (minimum across all customer flows):
1. Customers page → Customers hooks module (AST)
2. Customers hooks → Customers service module (AST)
3. Customers service → Backend customers controller (contract-matched)
4. Backend customers controller → Backend customers service (AST)
5. Backend customers service → Customer repository (AST)

**Key verification**: The customer flows should be structurally similar to vehicle
flows (same CRUD pattern), proving that squint's entity-aware detection is consistent.

**Verification queries**:
```sql
-- All customer flows
SELECT * FROM flows WHERE target_entity = 'customer' ORDER BY action_type;

-- Expect: view, create, update, delete (4 flows for customers)

-- Each should have definition steps crossing the HTTP boundary
SELECT f.slug, f.action_type, COUNT(fds.step_order) as step_count
FROM flows f
JOIN flow_definition_steps fds ON f.id = fds.flow_id
WHERE f.target_entity = 'customer'
GROUP BY f.id;
```

---

## Aggregate Verification Checklist

After running full ingest, check these aggregate properties:

### 1. Contract-matched interactions
```sql
SELECT COUNT(*) FROM interactions WHERE source = 'contract-matched';
-- Expected: 4-8 interactions (one per frontend-service↔backend-controller module pair)
-- Verified: 5 interactions with weights 7+7+6+5+3 = 28

SELECT COUNT(*) FROM interaction_definition_links;
-- Expected: ~28 rows (one per matched HTTP endpoint contract)
-- Actual: 6 unique rows after PK dedup (from_definition_id, to_definition_id, contract_id)
-- because many contracts share the same definition pair per module pair
```

### 2. Flow counts by tier
```sql
SELECT tier, COUNT(*) FROM flows GROUP BY tier;
-- Tier 0: 10-30 atomic flows (one per interaction chain segment)
-- Tier 1: 15-40 composite flows (traced from entry points)
```

### 3. Flow counts by action type
```sql
SELECT action_type, COUNT(*) FROM flows WHERE action_type IS NOT NULL GROUP BY action_type;
-- Expected minimum:
--   view:   5+ (one per page: login, dashboard, vehicles, customers, sales)
--   create: 3+ (vehicles, customers, sales)
--   update: 3+ (vehicles, customers, sales)
--   delete: 3+ (vehicles, customers, sales)
```

### 4. Flow counts by target entity
```sql
SELECT target_entity, COUNT(*) FROM flows WHERE target_entity IS NOT NULL GROUP BY target_entity;
-- Expected entities: vehicle, customer, sale (3 minimum)
-- Possibly also: auth/session/login, dashboard, repair
```

### 5. Coverage
```sql
-- Interaction coverage should be high (>80%)
SELECT
  (SELECT COUNT(DISTINCT interaction_id) FROM flow_steps) as covered,
  (SELECT COUNT(*) FROM interactions WHERE source != 'ast-import' AND pattern != 'test-internal') as total;
```

### 6. Feature flows should be empty after flows generate --force
```sql
SELECT COUNT(*) FROM features;
-- Expected: 0 (cleared by the cascade fix)

SELECT COUNT(*) FROM feature_flows;
-- Expected: 0
```

### 7. Definition links include contract_id (post-fix verification)
```sql
-- Every definition link should have a non-null contract_id
SELECT COUNT(*) FROM interaction_definition_links WHERE contract_id IS NULL;
-- Expected: 0

-- Verify multiple contracts per module pair are preserved
SELECT i.id, COUNT(idl.contract_id) as link_count
FROM interactions i
JOIN interaction_definition_links idl ON i.id = idl.interaction_id
WHERE i.source = 'contract-matched'
GROUP BY i.id
ORDER BY link_count DESC;
-- At least some interactions should have 3+ links (e.g., GET+POST+PUT+DELETE /vehicles
-- all going through the same module pair)
```

---

## What Squint Should NOT Produce

1. **No repair page flows**: There is no `Repairs.tsx` page in the frontend. The
   `useRepairs` hooks and `repairsService` exist but are orphaned (never called
   from any page). Squint should not produce user-facing repair flows from the
   frontend side. Backend repair controller flows may exist as `external` stakeholder
   entry points.

2. **No flows through shared-types**: The `packages/shared-types` package contains
   only type definitions (interfaces, enums). It has no runtime code and should not
   appear in flow definition steps.

3. **No flows through config/env**: Database configuration (`database.ts`, `env.ts`)
   should not be part of business flows. These are infrastructure modules.

4. **No duplicate flows**: Each (actionType, targetEntity, entryPointModuleId) tuple
   should appear at most once in the flows table.

5. **Reports controller is backend-only**: `ReportsController` serves
   `GET /api/reports/revenue` (admin-only, calls `salesService.getRevenueReport()`).
   There is no frontend page or service calling this endpoint. It should appear as
   an unmatched contract only.

## Additional Cross-Entity Behavior (not in top-5 flows)

**RepairsService → VehicleModel**: Similar to the sales→vehicle pattern,
`RepairsService.create()` and `update()` call `VehicleModel.update()` to set
vehicle status to `MAINTENANCE` or back to `AVAILABLE` based on active repairs.
This cross-entity interaction exists in the backend but is not reachable from
the frontend (no Repairs page), so it should not appear in user-facing flows.

---

## Running the Full Ingest

```bash
cd ~/Code/car-dealership

# Full clean ingest
node ~/Code/squint/bin/dev.js interactions generate --force
node ~/Code/squint/bin/dev.js flows generate --force --verbose
node ~/Code/squint/bin/dev.js features generate --verbose

# Verification
sqlite3 .squint.db "SELECT COUNT(*) FROM interactions WHERE source = 'contract-matched';"
sqlite3 .squint.db "SELECT COUNT(*) FROM interaction_definition_links;"
sqlite3 .squint.db "SELECT tier, COUNT(*) FROM flows GROUP BY tier;"
sqlite3 .squint.db "SELECT action_type, target_entity, slug FROM flows WHERE tier = 1 ORDER BY target_entity, action_type;"
sqlite3 .squint.db "SELECT COUNT(*) FROM features;"
sqlite3 .squint.db "SELECT COUNT(*) FROM feature_flows;"
```
