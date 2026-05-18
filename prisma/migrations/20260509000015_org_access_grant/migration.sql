-- OrgAccessGrant: cross-org library read access. Owner-managed via admin panel.
-- Backs the higher-tier subscription that lets one org see another org's
-- candidate library.

CREATE TABLE "OrgAccessGrant" (
    "id" TEXT NOT NULL,
    "viewerOrgId" TEXT NOT NULL,
    "providerOrgId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'library_read',
    "grantedByUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "OrgAccessGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgAccessGrant_viewerOrgId_providerOrgId_scope_key"
  ON "OrgAccessGrant"("viewerOrgId", "providerOrgId", "scope");
CREATE INDEX "OrgAccessGrant_viewerOrgId_idx" ON "OrgAccessGrant"("viewerOrgId");
CREATE INDEX "OrgAccessGrant_providerOrgId_idx" ON "OrgAccessGrant"("providerOrgId");
