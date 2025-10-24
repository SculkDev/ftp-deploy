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
    return itemName === exclusion || itemName.startsWith(exclusion + '/');
  });
}

function getAllFiles(dirPath, arrayOfFiles = [], baseDir = dirPath, exclusions = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    const relativePath = path.relative(baseDir, filePath);
    
    if (shouldExclude(relativePath, exclusions)) {
      return;
    }
    
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      arrayOfFiles = getAllFiles(filePath, arrayOfFiles, baseDir, exclusions);
    } else {
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

async function createFTPClient(ftpServer, ftpPort, ftpUsername, ftpPassword, useSecure) {
  const client = new ftp.Client();
  client.ftp.verbose = core.isDebug();
  
  // Set timeout to 60 seconds to match server's timeout
  client.ftp.timeout = 60000;
  
  await client.access({
    host: ftpServer,
    port: ftpPort,
    user: ftpUsername,
    password: ftpPassword,
    secure: useSecure,
    secureOptions: {
      rejectUnauthorized: false
    }
  });
  
  return client;
}

async function keepAlive(client) {
  try {
    await client.send('NOOP');
  } catch (error) {
    // Ignore NOOP errors
  }
}

async function uploadWithRetry(client, localPath, remotePath, ftpConfig, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.uploadFrom(localPath, remotePath);
      return true;
    } catch (error) {
      lastError = error;
      const isConnectionError = 
        error.message.includes('ECONNRESET') || 
        error.message.includes('closed') ||
        error.message.includes('Timeout') ||
        error.code === 421;
      
      if (isConnectionError && attempt < maxRetries) {
        core.warning(`Connection lost during upload (attempt ${attempt}/${maxRetries}), reconnecting...`);
        
        try {
          client.close();
        } catch (e) {}
        
        // Wait before reconnecting
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Reconnect
        const newClient = await createFTPClient(
          ftpConfig.server,
          ftpConfig.port,
          ftpConfig.username,
          ftpConfig.password,
          ftpConfig.secure
        );
        
        // Copy the new client to the old reference
        Object.assign(client, newClient);
        
        // Navigate back to the correct directory
        await client.cd(ftpConfig.remoteDir);
      } else {
        throw lastError;
      }
    }
  }
  
  throw lastError;
}

async function uploadFiles(client, buildDir, remoteDir, excludeIndex, exclusions, ftpConfig) {
  core.info('📤 Uploading files...');
  
  const files = getAllFiles(buildDir, [], buildDir, exclusions);
  const indexFile = files.find(f => f === 'index.html' || f === path.normalize('index.html'));
  const otherFiles = files.filter(f => f !== indexFile);
  const filesToUpload = excludeIndex ? otherFiles : files;
  
  core.info(`Uploading ${filesToUpload.length} files...`);
  
  await client.cd(remoteDir);
  
  const createdDirs = new Set();
  let fileCount = 0;
  let lastKeepAlive = Date.now();
  
  for (const file of filesToUpload) {
    const localPath = path.join(buildDir, file);
    const remotePath = file.replace(/\\/g, '/');
    
    // Send keepalive every 30 seconds
    if (Date.now() - lastKeepAlive > 30000) {
      await keepAlive(client);
      lastKeepAlive = Date.now();
    }
    
    // Ensure directory exists
    const remoteFileDir = path.posix.dirname(remotePath);
    if (remoteFileDir && remoteFileDir !== '.' && !createdDirs.has(remoteFileDir)) {
      try {
        await client.ensureDir(remoteFileDir);
        await client.cd(remoteDir);
        createdDirs.add(remoteFileDir);
      } catch (error) {
        core.warning(`Failed to create directory ${remoteFileDir}: ${error.message}`);
      }
    }
    
    try {
      core.info(`  ⬆️  Uploading: ${file}`);
      await uploadWithRetry(client, localPath, remotePath, ftpConfig);
      fileCount++;
      
      // Send keepalive every 10 files
      if (fileCount % 10 === 0) {
        await keepAlive(client);
        lastKeepAlive = Date.now();
      }
    } catch (uploadError) {
      core.warning(`Failed to upload ${file} after retries: ${uploadError.message}`);
    }
  }
  
  return indexFile;
}

async function uploadIndexFile(client, buildDir, remoteDir, indexFile, ftpConfig) {
  if (!indexFile) {
    core.info('⚠️  No index.html file found in build directory');
    return;
  }
  
  core.info('📄 Uploading index.html last...');
  
  const localPath = path.join(buildDir, indexFile);
  const remotePath = indexFile.replace(/\\/g, '/');
  
  await client.cd(remoteDir);
  
  try {
    await uploadWithRetry(client, localPath, remotePath, ftpConfig);
    core.info('  ✅ index.html uploaded successfully');
  } catch (error) {
    throw new Error(`Failed to upload index.html: ${error.message}`);
  }
}

async function run() {
  let client = null;
  
  try {
    const ftpServer = core.getInput('ftp-server', { required: true });
    const ftpUsername = core.getInput('ftp-username', { required: true });
    const ftpPassword = core.getInput('ftp-password', { required: true });
    const ftpRemoteDir = core.getInput('ftp-remote-dir', { required: true });
    const buildDir = core.getInput('build-dir', { required: true });
    const exclusionsString = core.getInput('exclusions');
    const ftpPort = parseInt(core.getInput('ftp-port') || '21', 10);
    const useSecure = core.getInput('secure') === 'true';
    
    const exclusions = parseExclusions(exclusionsString);
    
    const ftpConfig = {
      server: ftpServer,
      port: ftpPort,
      username: ftpUsername,
      password: ftpPassword,
      secure: useSecure,
      remoteDir: ftpRemoteDir
    };
    
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
    client = await createFTPClient(ftpServer, ftpPort, ftpUsername, ftpPassword, useSecure);
    core.info('✅ Connected successfully');
    core.info('');
    
    await ensureRemoteDir(client, ftpRemoteDir);
    
    await cleanupRemoteDirectory(client, ftpRemoteDir, exclusions);
    core.info('');
    
    const indexFile = await uploadFiles(client, buildDir, ftpRemoteDir, true, exclusions, ftpConfig);
    core.info('');
    
    await uploadIndexFile(client, buildDir, ftpRemoteDir, indexFile, ftpConfig);
    core.info('');
    
    core.info('✅ Deployment completed successfully!');
    
  } catch (error) {
    core.setFailed(`❌ Deployment failed: ${error.message}`);
    if (core.isDebug()) {
      core.error(error.stack);
    }
  } finally {
    if (client) {
      client.close();
    }
  }
}

run();