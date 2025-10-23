const core = require('@actions/core');
const ftp = require('basic-ftp');
const fs = require('fs');
const path = require('path');

function parseExclusions(exclusionsString) {
  if (!exclusionsString || exclusionsString.trim() === '') {
    return [];
  }
  return exclusionsString.split(',').map(item => item.trim()).filter(item => item !== '');
}

function shouldExclude(itemName, exclusions) {
  return exclusions.some(exclusion => {
    // Exact match or starts with (for directories)
    return itemName === exclusion || itemName.startsWith(exclusion + '/');
  });
}

function getAllFiles(dirPath, arrayOfFiles = [], baseDir = dirPath) {
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      arrayOfFiles = getAllFiles(filePath, arrayOfFiles, baseDir);
    } else {
      const relativePath = path.relative(baseDir, filePath);
      arrayOfFiles.push(relativePath);
    }
  });

  return arrayOfFiles;
}

async function cleanupRemoteDirectory(client, remoteDir, exclusions) {
  core.info('🗑️  Cleaning up remote directory...');
  
  try {
    await client.cd(remoteDir);
    
    const list = await client.list();
    
    core.info(`Found ${list.length} items in remote directory`);
    
    for (const item of list) {
      if (shouldExclude(item.name, exclusions)) {
        core.info(`  ⏭️  Skipping (excluded): ${item.name}`);
        continue;
      }
      
      try {
        if (item.isDirectory) {
          core.info(`  🗑️  Deleting directory: ${item.name}`);
          await client.removeDir(item.name);
        } else {
          core.info(`  🗑️  Deleting file: ${item.name}`);
          await client.remove(item.name);
        }
      } catch (deleteError) {
        core.warning(`Failed to delete ${item.name}: ${deleteError.message}`);
      }
    }
    
    core.info('✅ Cleanup completed');
  } catch (error) {
    throw new Error(`Failed to cleanup remote directory: ${error.message}`);
  }
}

async function ensureRemoteDir(client, remotePath) {
  const dirs = remotePath.split('/').filter(d => d !== '');
  let currentPath = '/';
  
  for (const dir of dirs) {
    currentPath = path.posix.join(currentPath, dir);
    try {
      await client.cd(currentPath);
    } catch (error) {
      await client.ensureDir(currentPath);
    }
  }
}

async function uploadFiles(client, buildDir, remoteDir, excludeIndex) {
  core.info('📤 Uploading files...');
  
  const files = getAllFiles(buildDir);
  
  const indexFile = files.find(f => f === 'index.html' || f === path.normalize('index.html'));
  const otherFiles = files.filter(f => f !== indexFile);
  
  const filesToUpload = excludeIndex ? otherFiles : files;
  
  core.info(`Uploading ${filesToUpload.length} files...`);
  
  await client.cd(remoteDir);
  
  for (const file of filesToUpload) {
    const localPath = path.join(buildDir, file);
    const remotePath = file.replace(/\\/g, '/'); // Normalize path separators for FTP
    
    const remoteFileDir = path.posix.dirname(remotePath);
    if (remoteFileDir && remoteFileDir !== '.') {
      try {
        await client.ensureDir(remoteFileDir);
        await client.cd(remoteDir); // Go back to base directory
      } catch (error) {
        core.warning(`Failed to create directory ${remoteFileDir}: ${error.message}`);
      }
    }
    
    try {
      core.info(`  ⬆️  Uploading: ${file}`);
      await client.uploadFrom(localPath, remotePath);
    } catch (uploadError) {
      core.warning(`Failed to upload ${file}: ${uploadError.message}`);
    }
  }
  
  return indexFile;
}

async function uploadIndexFile(client, buildDir, remoteDir, indexFile) {
  if (!indexFile) {
    core.info('⚠️  No index.html file found in build directory');
    return;
  }
  
  core.info('📄 Uploading index.html last...');
  
  const localPath = path.join(buildDir, indexFile);
  const remotePath = indexFile.replace(/\\/g, '/');
  
  await client.cd(remoteDir);
  
  try {
    await client.uploadFrom(localPath, remotePath);
    core.info('  ✅ index.html uploaded successfully');
  } catch (error) {
    throw new Error(`Failed to upload index.html: ${error.message}`);
  }
}

async function run() {
  const client = new ftp.Client();
  client.ftp.verbose = core.isDebug();
  
  try {
    // Get inputs
    const ftpServer = core.getInput('ftp-server', { required: true });
    const ftpUsername = core.getInput('ftp-username', { required: true });
    const ftpPassword = core.getInput('ftp-password', { required: true });
    const ftpRemoteDir = core.getInput('ftp-remote-dir', { required: true });
    const buildDir = core.getInput('build-dir', { required: true });
    const exclusionsString = core.getInput('exclusions');
    const ftpPort = parseInt(core.getInput('ftp-port') || '21', 10);
    const useSecure = core.getInput('secure') === 'true';
    
    const exclusions = parseExclusions(exclusionsString);
    
    core.info('🚀 Starting FTP deployment...');
    core.info(`📡 Server: ${ftpServer}:${ftpPort}`);
    core.info(`👤 Username: ${ftpUsername}`);
    core.info(`📂 Remote directory: ${ftpRemoteDir}`);
    core.info(`📁 Build directory: ${buildDir}`);
    core.info(`🔒 Secure connection: ${useSecure}`);
    core.info(`📋 Exclusions: ${exclusions.length > 0 ? exclusions.join(', ') : 'none'}`);
    core.info('');
    
    if (!fs.existsSync(buildDir)) {
      throw new Error(`Build directory does not exist: ${buildDir}`);
    }
    
    core.info('🔌 Connecting to FTP server...');
    await client.access({
      host: ftpServer,
      port: ftpPort,
      user: ftpUsername,
      password: ftpPassword,
      secure: useSecure,
      secureOptions: {
        rejectUnauthorized: false // Allow self-signed certificates
      }
    });
    core.info('✅ Connected successfully');
    core.info('');
    
    await ensureRemoteDir(client, ftpRemoteDir);
    
    await cleanupRemoteDirectory(client, ftpRemoteDir, exclusions);
    core.info('');
    
    const indexFile = await uploadFiles(client, buildDir, ftpRemoteDir, true);
    core.info('');
    
    await uploadIndexFile(client, buildDir, ftpRemoteDir, indexFile);
    core.info('');
    
    core.info('✅ Deployment completed successfully!');
    
  } catch (error) {
    core.setFailed(`❌ Deployment failed: ${error.message}`);
    if (core.isDebug()) {
      core.error(error.stack);
    }
  } finally {
    client.close();
  }
}

run();