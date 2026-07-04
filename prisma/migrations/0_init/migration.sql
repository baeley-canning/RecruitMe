-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT,
    "excludedCompanies" TEXT,
    "location" TEXT,
    "location2" TEXT,
    "rawJd" TEXT NOT NULL,
    "parsedRole" TEXT,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "scoringWeights" TEXT,
    "shareToken" TEXT,
    "shareTokenExpiresAt" TIMESTAMP(3),
    "isRemote" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastScoredAt" TIMESTAMP(3),
    "lastParsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "orgId" TEXT,
    "clientId" TEXT,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperApiToken" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScraperApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeJob" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'profile',
    "profileUrl" TEXT,
    "searchQuery" TEXT,
    "searchLocation" TEXT,
    "scorePayload" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "error" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "candidateId" TEXT,
    "identityId" TEXT,
    "requestedBy" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "searchRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScrapeJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperHeartbeat" (
    "workerId" TEXT NOT NULL,
    "lastPollAt" TIMESTAMP(3),
    "jobsOk" INTEGER NOT NULL DEFAULT 0,
    "jobsFailed" INTEGER NOT NULL DEFAULT 0,
    "pollErrors" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScraperHeartbeat_pkey" PRIMARY KEY ("workerId")
);

-- CreateTable
CREATE TABLE "SearchRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "jobId" TEXT,
    "requestedBy" TEXT,
    "rawQuery" TEXT NOT NULL,
    "parsedQuery" TEXT NOT NULL,
    "location" TEXT,
    "sources" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "libraryStatus" TEXT NOT NULL DEFAULT 'skipped',
    "linkedinStatus" TEXT NOT NULL DEFAULT 'skipped',
    "seekStatus" TEXT NOT NULL DEFAULT 'skipped',
    "libraryCount" INTEGER NOT NULL DEFAULT 0,
    "linkedinCount" INTEGER NOT NULL DEFAULT 0,
    "seekCount" INTEGER NOT NULL DEFAULT 0,
    "dedupedCount" INTEGER NOT NULL DEFAULT 0,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchRunResult" (
    "id" TEXT NOT NULL,
    "searchRunId" TEXT NOT NULL,
    "mergeKey" TEXT NOT NULL,
    "sources" TEXT NOT NULL DEFAULT '[]',
    "candidateId" TEXT,
    "candidateIdentityId" TEXT,
    "profileUrl" TEXT,
    "name" TEXT,
    "headline" TEXT,
    "location" TEXT,
    "snippet" TEXT,
    "updatedAgo" TEXT,
    "matchScore" INTEGER,
    "relevance" DOUBLE PRECISION,
    "rank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchRunResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "website" TEXT,
    "primaryContact" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clientId" TEXT,
    "candidateId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedBy" TEXT,
    "matchScore" INTEGER,
    "cvVersion" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "clientFeedback" TEXT,
    "feedbackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Placement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientId" TEXT,
    "jobId" TEXT,
    "candidateId" TEXT NOT NULL,
    "submissionId" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startDate" TIMESTAMP(3),
    "salaryPlaced" INTEGER,
    "feeType" TEXT NOT NULL DEFAULT 'percentage',
    "feePct" DOUBLE PRECISION,
    "feeAmount" INTEGER,
    "invoiceRef" TEXT,
    "invoicedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "guaranteeMonths" INTEGER,
    "guaranteeExpiry" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Placement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "candidateId" TEXT,
    "jobId" TEXT,
    "clientId" TEXT,
    "placementId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'follow_up',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTag" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTagAssignment" (
    "candidateId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateTagAssignment_pkey" PRIMARY KEY ("candidateId","tagId")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "orgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "orgId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "userId" TEXT,
    "createdBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "orgId" TEXT,
    "archivedJobTitle" TEXT,
    "archivedJobCompany" TEXT,
    "candidateIdentityId" TEXT,
    "name" TEXT NOT NULL,
    "headline" TEXT,
    "location" TEXT,
    "linkedinUrl" TEXT,
    "jobAdderUrl" TEXT,
    "seekUrl" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "firmableData" TEXT,
    "firmableEnrichedAt" TIMESTAMP(3),
    "profileText" TEXT,
    "profileTextHash" TEXT,
    "matchScore" INTEGER,
    "matchReason" TEXT,
    "fetchPriorityScore" INTEGER,
    "fetchPriorityReason" TEXT,
    "acceptanceScore" INTEGER,
    "acceptanceReason" TEXT,
    "scoreBreakdown" TEXT,
    "notes" TEXT,
    "screeningData" TEXT,
    "interviewNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "statusHistory" TEXT,
    "contactedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "importBatchId" TEXT,
    "suitability" TEXT,
    "photoFileId" TEXT,
    "profileCapturedAt" TIMESTAMP(3),
    "captureMetadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateFile" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "storageKey" TEXT,
    "size" INTEGER NOT NULL,
    "dataHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FetchSession" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "linkedinUrl" TEXT NOT NULL,
    "candidateName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "completedAt" TIMESTAMP(3),
    "orgId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FetchSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringWeightPreset" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "weights" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoringWeightPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactEvent" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "orgId" TEXT,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreCorrection" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT,
    "orgId" TEXT,
    "originalScore" INTEGER NOT NULL,
    "recruiterScore" INTEGER NOT NULL,
    "reason" TEXT,
    "roleTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "queries" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "target" INTEGER NOT NULL DEFAULT 20,
    "lastRunAt" TIMESTAMP(3),
    "lastResultCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchSession" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "queries" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "collected" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "importedIds" TEXT NOT NULL DEFAULT '[]',
    "message" TEXT,
    "orgId" TEXT,
    "avgScore" DOUBLE PRECISION,
    "candidatesRejected" INTEGER,
    "totalExamined" INTEGER,
    "evaluation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobParseHistory" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "parsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anchorTerms" TEXT NOT NULL,
    "mustHaveCount" INTEGER NOT NULL,
    "changes" TEXT NOT NULL,
    "evaluation" TEXT NOT NULL,

    CONSTRAINT "JobParseHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "meta" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateIdentity" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "primaryEmail" TEXT,
    "primaryPhone" TEXT,
    "linkedinUrl" TEXT,
    "jobAdderUrl" TEXT,
    "seekUrl" TEXT,
    "mergedIntoIdentityId" TEXT,
    "currentInsightId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateIdentityAlias" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "CandidateIdentityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateIdentityMerge" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceIdentityId" TEXT NOT NULL,
    "survivorIdentityId" TEXT NOT NULL,
    "mergedByUserId" TEXT,
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "isTombstone" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CandidateIdentityMerge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileInsight" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "factsJson" TEXT NOT NULL,
    "extractionVersion" INTEGER NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "extractedBy" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "sourceProfileTextHash" TEXT NOT NULL,
    "sourceInputHash" TEXT,
    "contributingPlatforms" TEXT NOT NULL DEFAULT '[]',
    "sourceCandidateId" TEXT,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ProfileInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceCheck" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "refereeName" TEXT NOT NULL,
    "refereeTitle" TEXT,
    "refereeCompany" TEXT,
    "refereeEmail" TEXT,
    "refereePhone" TEXT,
    "relationship" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "questions" TEXT,
    "responses" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchedSearch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "jobId" TEXT,
    "createdBy" TEXT,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "location" TEXT,
    "notifyFrom" TIMESTAMP(3) NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 1440,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAfter" TIMESTAMP(3),
    "lastRunId" TEXT,
    "lastCheckAt" TIMESTAMP(3),
    "lastCheckStatus" TEXT,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileUpdateHit" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seekId" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "candidateId" TEXT,
    "name" TEXT,
    "headline" TEXT,
    "location" TEXT,
    "updatedAgo" TEXT,
    "updatedAtBucket" TIMESTAMP(3) NOT NULL,
    "flaggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProfileUpdateHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_shareToken_key" ON "Job"("shareToken");

-- CreateIndex
CREATE INDEX "Job_orgId_idx" ON "Job"("orgId");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_clientId_idx" ON "Job"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Org_name_key" ON "Org"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ScraperApiToken_tokenHash_key" ON "ScraperApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ScraperApiToken_orgId_idx" ON "ScraperApiToken"("orgId");

-- CreateIndex
CREATE INDEX "ScrapeJob_orgId_status_idx" ON "ScrapeJob"("orgId", "status");

-- CreateIndex
CREATE INDEX "ScrapeJob_orgId_platform_idx" ON "ScrapeJob"("orgId", "platform");

-- CreateIndex
CREATE INDEX "ScrapeJob_status_priority_createdAt_idx" ON "ScrapeJob"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "ScrapeJob_searchRunId_status_idx" ON "ScrapeJob"("searchRunId", "status");

-- CreateIndex
CREATE INDEX "SearchRun_orgId_createdAt_idx" ON "SearchRun"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchRun_orgId_status_idx" ON "SearchRun"("orgId", "status");

-- CreateIndex
CREATE INDEX "SearchRun_jobId_createdAt_idx" ON "SearchRun"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchRun_status_updatedAt_idx" ON "SearchRun"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SearchRunResult_searchRunId_idx" ON "SearchRunResult"("searchRunId");

-- CreateIndex
CREATE INDEX "SearchRunResult_candidateId_idx" ON "SearchRunResult"("candidateId");

-- CreateIndex
CREATE INDEX "SearchRunResult_searchRunId_candidateId_idx" ON "SearchRunResult"("searchRunId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchRunResult_searchRunId_mergeKey_key" ON "SearchRunResult"("searchRunId", "mergeKey");

-- CreateIndex
CREATE INDEX "Client_orgId_idx" ON "Client"("orgId");

-- CreateIndex
CREATE INDEX "Submission_orgId_idx" ON "Submission"("orgId");

-- CreateIndex
CREATE INDEX "Submission_jobId_idx" ON "Submission"("jobId");

-- CreateIndex
CREATE INDEX "Submission_candidateId_idx" ON "Submission"("candidateId");

-- CreateIndex
CREATE INDEX "Submission_clientId_idx" ON "Submission"("clientId");

-- CreateIndex
CREATE INDEX "Placement_orgId_idx" ON "Placement"("orgId");

-- CreateIndex
CREATE INDEX "Placement_clientId_idx" ON "Placement"("clientId");

-- CreateIndex
CREATE INDEX "Placement_jobId_idx" ON "Placement"("jobId");

-- CreateIndex
CREATE INDEX "Placement_candidateId_idx" ON "Placement"("candidateId");

-- CreateIndex
CREATE INDEX "Reminder_orgId_idx" ON "Reminder"("orgId");

-- CreateIndex
CREATE INDEX "Reminder_orgId_dismissed_dueAt_idx" ON "Reminder"("orgId", "dismissed", "dueAt");

-- CreateIndex
CREATE INDEX "CandidateTag_orgId_idx" ON "CandidateTag"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTag_orgId_label_key" ON "CandidateTag"("orgId", "label");

-- CreateIndex
CREATE INDEX "CandidateTagAssignment_candidateId_idx" ON "CandidateTagAssignment"("candidateId");

-- CreateIndex
CREATE INDEX "CandidateTagAssignment_tagId_idx" ON "CandidateTagAssignment"("tagId");

-- CreateIndex
CREATE INDEX "OrgAccessGrant_viewerOrgId_idx" ON "OrgAccessGrant"("viewerOrgId");

-- CreateIndex
CREATE INDEX "OrgAccessGrant_providerOrgId_idx" ON "OrgAccessGrant"("providerOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgAccessGrant_viewerOrgId_providerOrgId_scope_key" ON "OrgAccessGrant"("viewerOrgId", "providerOrgId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_kind_expiresAt_idx" ON "AuthToken"("kind", "expiresAt");

-- CreateIndex
CREATE INDEX "Candidate_linkedinUrl_idx" ON "Candidate"("linkedinUrl");

-- CreateIndex
CREATE INDEX "Candidate_orgId_idx" ON "Candidate"("orgId");

-- CreateIndex
CREATE INDEX "Candidate_status_idx" ON "Candidate"("status");

-- CreateIndex
CREATE INDEX "Candidate_orgId_createdAt_idx" ON "Candidate"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Candidate_orgId_profileCapturedAt_idx" ON "Candidate"("orgId", "profileCapturedAt");

-- CreateIndex
CREATE INDEX "Candidate_jobId_matchScore_idx" ON "Candidate"("jobId", "matchScore");

-- CreateIndex
CREATE INDEX "Candidate_candidateIdentityId_idx" ON "Candidate"("candidateIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_jobId_linkedinUrl_key" ON "Candidate"("jobId", "linkedinUrl");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateFile_candidateId_dataHash_key" ON "CandidateFile"("candidateId", "dataHash");

-- CreateIndex
CREATE INDEX "FetchSession_jobId_idx" ON "FetchSession"("jobId");

-- CreateIndex
CREATE INDEX "FetchSession_status_idx" ON "FetchSession"("status");

-- CreateIndex
CREATE INDEX "FetchSession_jobId_status_idx" ON "FetchSession"("jobId", "status");

-- CreateIndex
CREATE INDEX "FetchSession_orgId_status_idx" ON "FetchSession"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FetchSession_candidateId_key" ON "FetchSession"("candidateId");

-- CreateIndex
CREATE INDEX "ScoringWeightPreset_orgId_idx" ON "ScoringWeightPreset"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringWeightPreset_orgId_name_key" ON "ScoringWeightPreset"("orgId", "name");

-- CreateIndex
CREATE INDEX "ContactEvent_candidateId_idx" ON "ContactEvent"("candidateId");

-- CreateIndex
CREATE INDEX "ContactEvent_orgId_idx" ON "ContactEvent"("orgId");

-- CreateIndex
CREATE INDEX "ContactEvent_jobId_idx" ON "ContactEvent"("jobId");

-- CreateIndex
CREATE INDEX "ScoreCorrection_orgId_idx" ON "ScoreCorrection"("orgId");

-- CreateIndex
CREATE INDEX "ScoreCorrection_candidateId_idx" ON "ScoreCorrection"("candidateId");

-- CreateIndex
CREATE INDEX "SavedSearch_jobId_idx" ON "SavedSearch"("jobId");

-- CreateIndex
CREATE INDEX "SavedSearch_orgId_idx" ON "SavedSearch"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedSearch_jobId_name_key" ON "SavedSearch"("jobId", "name");

-- CreateIndex
CREATE INDEX "SearchSession_jobId_idx" ON "SearchSession"("jobId");

-- CreateIndex
CREATE INDEX "SearchSession_jobId_status_idx" ON "SearchSession"("jobId", "status");

-- CreateIndex
CREATE INDEX "JobParseHistory_jobId_idx" ON "JobParseHistory"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "LoginAttempt_key_key" ON "LoginAttempt"("key");

-- CreateIndex
CREATE INDEX "LoginAttempt_resetAt_idx" ON "LoginAttempt"("resetAt");

-- CreateIndex
CREATE INDEX "UsageEvent_orgId_type_createdAt_idx" ON "UsageEvent"("orgId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_orgId_createdAt_idx" ON "UsageEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateIdentity_orgId_idx" ON "CandidateIdentity"("orgId");

-- CreateIndex
CREATE INDEX "CandidateIdentity_orgId_primaryEmail_idx" ON "CandidateIdentity"("orgId", "primaryEmail");

-- CreateIndex
CREATE INDEX "CandidateIdentity_mergedIntoIdentityId_idx" ON "CandidateIdentity"("mergedIntoIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateIdentity_orgId_linkedinUrl_key" ON "CandidateIdentity"("orgId", "linkedinUrl");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateIdentity_orgId_jobAdderUrl_key" ON "CandidateIdentity"("orgId", "jobAdderUrl");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateIdentity_orgId_seekUrl_key" ON "CandidateIdentity"("orgId", "seekUrl");

-- CreateIndex
CREATE INDEX "CandidateIdentityAlias_identityId_idx" ON "CandidateIdentityAlias"("identityId");

-- CreateIndex
CREATE INDEX "CandidateIdentityAlias_kind_value_idx" ON "CandidateIdentityAlias"("kind", "value");

-- CreateIndex
CREATE INDEX "CandidateIdentityMerge_orgId_survivorIdentityId_idx" ON "CandidateIdentityMerge"("orgId", "survivorIdentityId");

-- CreateIndex
CREATE INDEX "CandidateIdentityMerge_orgId_sourceIdentityId_idx" ON "CandidateIdentityMerge"("orgId", "sourceIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateIdentityMerge_orgId_sourceIdentityId_survivorIdent_key" ON "CandidateIdentityMerge"("orgId", "sourceIdentityId", "survivorIdentityId", "isTombstone");

-- CreateIndex
CREATE INDEX "ProfileInsight_orgId_identityId_supersededAt_idx" ON "ProfileInsight"("orgId", "identityId", "supersededAt");

-- CreateIndex
CREATE INDEX "ProfileInsight_orgId_extractionVersion_idx" ON "ProfileInsight"("orgId", "extractionVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileInsight_orgId_identityId_sourceProfileTextHash_extra_key" ON "ProfileInsight"("orgId", "identityId", "sourceProfileTextHash", "extractionVersion");

-- CreateIndex
CREATE INDEX "WatchedSearch_orgId_active_idx" ON "WatchedSearch"("orgId", "active");

-- CreateIndex
CREATE INDEX "WatchedSearch_active_nextRunAfter_idx" ON "WatchedSearch"("active", "nextRunAfter");

-- CreateIndex
CREATE UNIQUE INDEX "WatchedSearch_orgId_name_key" ON "WatchedSearch"("orgId", "name");

-- CreateIndex
CREATE INDEX "ProfileUpdateHit_orgId_seen_flaggedAt_idx" ON "ProfileUpdateHit"("orgId", "seen", "flaggedAt");

-- CreateIndex
CREATE INDEX "ProfileUpdateHit_watchId_flaggedAt_idx" ON "ProfileUpdateHit"("watchId", "flaggedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileUpdateHit_watchId_seekId_updatedAtBucket_key" ON "ProfileUpdateHit"("watchId", "seekId", "updatedAtBucket");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScraperApiToken" ADD CONSTRAINT "ScraperApiToken_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScrapeJob" ADD CONSTRAINT "ScrapeJob_searchRunId_fkey" FOREIGN KEY ("searchRunId") REFERENCES "SearchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchRunResult" ADD CONSTRAINT "SearchRunResult_searchRunId_fkey" FOREIGN KEY ("searchRunId") REFERENCES "SearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateTagAssignment" ADD CONSTRAINT "CandidateTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "CandidateTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateTagAssignment" ADD CONSTRAINT "CandidateTagAssignment_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_candidateIdentityId_fkey" FOREIGN KEY ("candidateIdentityId") REFERENCES "CandidateIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateFile" ADD CONSTRAINT "CandidateFile_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FetchSession" ADD CONSTRAINT "FetchSession_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FetchSession" ADD CONSTRAINT "FetchSession_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreCorrection" ADD CONSTRAINT "ScoreCorrection_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchSession" ADD CONSTRAINT "SearchSession_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobParseHistory" ADD CONSTRAINT "JobParseHistory_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateIdentity" ADD CONSTRAINT "CandidateIdentity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateIdentity" ADD CONSTRAINT "CandidateIdentity_currentInsightId_fkey" FOREIGN KEY ("currentInsightId") REFERENCES "ProfileInsight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateIdentityAlias" ADD CONSTRAINT "CandidateIdentityAlias_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "CandidateIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileInsight" ADD CONSTRAINT "ProfileInsight_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "CandidateIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceCheck" ADD CONSTRAINT "ReferenceCheck_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileUpdateHit" ADD CONSTRAINT "ProfileUpdateHit_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "WatchedSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

