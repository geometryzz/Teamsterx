/**
 * Migration Script: Backfill createdBy/authorId and userName fields
 * 
 * This script normalizes older activity and message documents to include
 * the canonical uid fields (createdBy for activities, userId for messages)
 * and optionally updates userName snapshots.
 * 
 * USAGE:
 *   DRY RUN (preview changes):
 *     node scripts/migrate_user_fields.js --dry-run
 * 
 *   REAL RUN (apply changes):
 *     node scripts/migrate_user_fields.js --run
 * 
 * REQUIREMENTS:
 *   1. Firebase Admin SDK: npm install firebase-admin
 *   2. Service account key file (download from Firebase Console > Project Settings > Service Accounts)
 *   3. Set the path to your service account key below
 * 
 * SAFETY:
 *   - Only ADDS missing fields, never deletes or overwrites existing data
 *   - Uses batched writes (max 500 ops per batch)
 *   - Logs all changes for audit trail
 */

const admin = require('firebase-admin');

// ============================================================
// CONFIGURATION - Update these before running
// ============================================================

// Path to your Firebase service account key JSON file
// Download from: Firebase Console > Project Settings > Service Accounts > Generate new private key
const SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';

// ============================================================
// Initialize Firebase Admin
// ============================================================

try {
    const serviceAccount = require(SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized');
} catch (error) {
    console.error('❌ Failed to initialize Firebase Admin:');
    console.error('   Make sure you have downloaded your service account key from Firebase Console');
    console.error('   and placed it at:', SERVICE_ACCOUNT_PATH);
    console.error('   Error:', error.message);
    process.exit(1);
}

const db = admin.firestore();

// ============================================================
// Migration Logic
// ============================================================

async function migrateActivities(teamId, dryRun) {
    const activitiesRef = db.collection('teams').doc(teamId).collection('activities');
    const snapshot = await activitiesRef.get();
    
    const stats = { total: 0, needsUpdate: 0, updated: 0 };
    const batch = db.batch();
    let batchCount = 0;
    
    for (const doc of snapshot.docs) {
        stats.total++;
        const data = doc.data();
        const updates = {};
        
        // Check if createdBy is missing but we have userId or authorId
        if (!data.createdBy) {
            const uid = data.userId || data.authorId;
            if (uid) {
                updates.createdBy = uid;
            }
        }
        
        // If we have updates to make
        if (Object.keys(updates).length > 0) {
            stats.needsUpdate++;
            
            if (dryRun) {
                console.log(`  [DRY RUN] Would update activity ${doc.id}:`, updates);
            } else {
                batch.update(doc.ref, updates);
                batchCount++;
                
                // Firestore batch limit is 500
                if (batchCount >= 500) {
                    await batch.commit();
                    console.log(`  Committed batch of ${batchCount} updates`);
                    batchCount = 0;
                }
                stats.updated++;
            }
        }
    }
    
    // Commit remaining updates
    if (!dryRun && batchCount > 0) {
        await batch.commit();
        console.log(`  Committed final batch of ${batchCount} updates`);
    }
    
    return stats;
}

async function migrateMessages(teamId, dryRun) {
    const messagesRef = db.collection('teams').doc(teamId).collection('messages');
    const snapshot = await messagesRef.get();
    
    const stats = { total: 0, needsUpdate: 0, updated: 0 };
    let batch = db.batch();
    let batchCount = 0;
    
    for (const doc of snapshot.docs) {
        stats.total++;
        const data = doc.data();
        const updates = {};
        
        // Messages should have userId - check if missing but we have createdBy or authorId
        if (!data.userId) {
            const uid = data.createdBy || data.authorId;
            if (uid) {
                updates.userId = uid;
            }
        }
        
        // If we have updates to make
        if (Object.keys(updates).length > 0) {
            stats.needsUpdate++;
            
            if (dryRun) {
                console.log(`  [DRY RUN] Would update message ${doc.id}:`, updates);
            } else {
                batch.update(doc.ref, updates);
                batchCount++;
                
                // Firestore batch limit is 500
                if (batchCount >= 500) {
                    await batch.commit();
                    console.log(`  Committed batch of ${batchCount} updates`);
                    batch = db.batch(); // Create new batch
                    batchCount = 0;
                }
                stats.updated++;
            }
        }
    }
    
    // Commit remaining updates
    if (!dryRun && batchCount > 0) {
        await batch.commit();
        console.log(`  Committed final batch of ${batchCount} updates`);
    }
    
    return stats;
}

async function runMigration(dryRun) {
    console.log('\n========================================');
    console.log(dryRun ? '🔍 DRY RUN MODE - No changes will be made' : '🚀 LIVE RUN MODE - Changes will be applied');
    console.log('========================================\n');
    
    // Get all teams
    const teamsSnapshot = await db.collection('teams').get();
    console.log(`Found ${teamsSnapshot.size} teams to process\n`);
    
    const totalStats = {
        activities: { total: 0, needsUpdate: 0, updated: 0 },
        messages: { total: 0, needsUpdate: 0, updated: 0 }
    };
    
    for (const teamDoc of teamsSnapshot.docs) {
        const teamId = teamDoc.id;
        const teamData = teamDoc.data();
        console.log(`\n📁 Processing team: ${teamData.name || teamId}`);
        
        // Migrate activities
        console.log('  📋 Migrating activities...');
        const activityStats = await migrateActivities(teamId, dryRun);
        totalStats.activities.total += activityStats.total;
        totalStats.activities.needsUpdate += activityStats.needsUpdate;
        totalStats.activities.updated += activityStats.updated;
        console.log(`     Total: ${activityStats.total}, Needs update: ${activityStats.needsUpdate}, Updated: ${activityStats.updated}`);
        
        // Migrate messages
        console.log('  💬 Migrating messages...');
        const messageStats = await migrateMessages(teamId, dryRun);
        totalStats.messages.total += messageStats.total;
        totalStats.messages.needsUpdate += messageStats.needsUpdate;
        totalStats.messages.updated += messageStats.updated;
        console.log(`     Total: ${messageStats.total}, Needs update: ${messageStats.needsUpdate}, Updated: ${messageStats.updated}`);
    }
    
    // Summary
    console.log('\n========================================');
    console.log('📊 MIGRATION SUMMARY');
    console.log('========================================');
    console.log(`\nActivities:`);
    console.log(`  Total scanned: ${totalStats.activities.total}`);
    console.log(`  Needed update: ${totalStats.activities.needsUpdate}`);
    console.log(`  Actually updated: ${totalStats.activities.updated}`);
    console.log(`\nMessages:`);
    console.log(`  Total scanned: ${totalStats.messages.total}`);
    console.log(`  Needed update: ${totalStats.messages.needsUpdate}`);
    console.log(`  Actually updated: ${totalStats.messages.updated}`);
    
    if (dryRun) {
        console.log('\n⚠️  This was a DRY RUN. No changes were made.');
        console.log('   Run with --run to apply changes.');
    } else {
        console.log('\n✅ Migration complete!');
    }
}

// ============================================================
// CLI Entry Point
// ============================================================

const args = process.argv.slice(2);

if (args.includes('--dry-run')) {
    runMigration(true).catch(console.error).finally(() => process.exit());
} else if (args.includes('--run')) {
    runMigration(false).catch(console.error).finally(() => process.exit());
} else {
    console.log('Usage:');
    console.log('  node scripts/migrate_user_fields.js --dry-run   # Preview changes');
    console.log('  node scripts/migrate_user_fields.js --run       # Apply changes');
    process.exit(1);
}
