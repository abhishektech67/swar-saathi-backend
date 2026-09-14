-- CreateEnum
CREATE TYPE "Role" AS ENUM ('THERAPIST', 'CAREGIVER', 'PATIENT');

-- CreateEnum
CREATE TYPE "ExerciseCategory" AS ENUM ('ARTICULATION', 'FLUENCY', 'VOICE');

-- CreateEnum
CREATE TYPE "CaregiverRelationship" AS ENUM ('PARENT', 'GUARDIAN', 'SPOUSE', 'OTHER');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "primaryDiagnosis" TEXT NOT NULL,
    "clinicalNotes" TEXT NOT NULL,
    "currentDifficultyLevel" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PatientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientTherapist" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PatientTherapist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientCaregiver" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "caregiverId" TEXT NOT NULL,
    "relationship" "CaregiverRelationship" NOT NULL,

    CONSTRAINT "PatientCaregiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exercise" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ExerciseCategory" NOT NULL,
    "difficultyLevel" INTEGER NOT NULL,
    "targetPhonemes" TEXT[],
    "instructions" TEXT NOT NULL,
    "gamePointsValue" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "Exercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExerciseAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "dueDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExerciseAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "s3Url" TEXT NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "pitchMeanHz" DOUBLE PRECISION NOT NULL,
    "clarityScore" DOUBLE PRECISION NOT NULL,
    "pronunciationScore" DOUBLE PRECISION NOT NULL,
    "difficultyAtAttempt" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaregiverFeedback" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "caregiverId" TEXT NOT NULL,
    "feedbackText" TEXT NOT NULL,
    "moodRating" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaregiverFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PatientProfile_userId_key" ON "PatientProfile"("userId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientTherapist" ADD CONSTRAINT "PatientTherapist_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientTherapist" ADD CONSTRAINT "PatientTherapist_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCaregiver" ADD CONSTRAINT "PatientCaregiver_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCaregiver" ADD CONSTRAINT "PatientCaregiver_caregiverId_fkey" FOREIGN KEY ("caregiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exercise" ADD CONSTRAINT "Exercise_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exercise" ADD CONSTRAINT "Exercise_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExerciseAssignment" ADD CONSTRAINT "ExerciseAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExerciseAssignment" ADD CONSTRAINT "ExerciseAssignment_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExerciseAssignment" ADD CONSTRAINT "ExerciseAssignment_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExerciseAssignment" ADD CONSTRAINT "ExerciseAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioLog" ADD CONSTRAINT "AudioLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioLog" ADD CONSTRAINT "AudioLog_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioLog" ADD CONSTRAINT "AudioLog_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaregiverFeedback" ADD CONSTRAINT "CaregiverFeedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaregiverFeedback" ADD CONSTRAINT "CaregiverFeedback_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaregiverFeedback" ADD CONSTRAINT "CaregiverFeedback_caregiverId_fkey" FOREIGN KEY ("caregiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
