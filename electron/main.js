const { app, BrowserWindow, ipcMain, Menu, Tray, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const isDev = process.env.NODE_ENV === 'development';
const dotenv = require('dotenv');
const dns = require('dns');
const ping = require('ping');
const nodemailer = require('nodemailer');
require('@electron/remote/main').initialize();
dotenv.config(); // Load environment variables

// Set the app user model ID for Windows
app.setAppUserModelId('com.j5pharmacy.pms');

let controlPanel;
let browserWindow;
let serverProcess;
let serverRunning = false;
let updateCheckInterval;
let pendingUpdate = null;
let updatePostponeCount = 0;
const MAX_POSTPONE_COUNT = 5; // Maximum times a user can postpone an update
let nodeCheckWindow;
let splashScreen;
let tray = null;

// Add settings to store minimize preference
let minimizeToTray = false;
let minimizeToTrayOnOpenBrowser = false;

// Store server state
function saveServerState(state) {
  const statePath = path.join(app.getPath('userData'), 'server-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ running: state }));
}

function loadServerState() {
  const statePath = path.join(app.getPath('userData'), 'server-state.json');
  try {
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath));
      return state.running;
    }
  } catch (err) {
    console.error('Error loading server state:', err);
  }
  return false;
}

// Store update state
function saveUpdateState(state) {
  const statePath = path.join(app.getPath('userData'), 'update-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function loadUpdateState() {
  const statePath = path.join(app.getPath('userData'), 'update-state.json');
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath));
    }
  } catch (err) {
    console.error('Error loading update state:', err);
  }
  return { postponeCount: 0, lastPostponeTime: null };
}

// Error logging setup
function logError(error) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${error}\n`;
  const logPath = isDev 
    ? path.join(__dirname, '../errorlog.txt')
    : path.join(app.getPath('userData'), 'errorlog.txt');

  console.error(logMessage); // Add console logging for immediate feedback
  fs.appendFile(logPath, logMessage, (err) => {
    if (err) console.error('Failed to write to error log:', err);
  });
}

function getAppPath() {
  if (isDev) {
    return path.join(__dirname, '..');
  } else {
    return app.getAppPath();
  }
}

// Update checking
function checkForUpdates() {
  return new Promise((resolve, reject) => {
    
    const options = {
      hostname: 'api.github.com',
      path: '/repos/J5PH-Dev/control-panel/releases/latest',
      headers: {
        'User-Agent': 'J5PH-Dev/control-panel',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    console.log('Checking for updates with URL:', `https://${options.hostname}${options.path}`);

    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          console.log('GitHub API Response Status:', res.statusCode);
          
          if (res.statusCode === 404) {
            throw new Error('Repository not found or no releases available');
          }
          if (res.statusCode === 401) {
            logError('GitHub token has expired or is invalid. Please update the token in .env file');
            throw new Error('GitHub token has expired. Please contact system administrator to update the token.');
          }
          if (res.statusCode === 403) {
            const resetTime = new Date(res.headers['x-ratelimit-reset'] * 1000);
            throw new Error(`API rate limit exceeded. Resets at ${resetTime.toLocaleString()}`);
          }
          if (res.statusCode !== 200) {
            throw new Error(`GitHub API returned status ${res.statusCode}`);
          }
          
          const release = JSON.parse(data);
          console.log('Release data:', {
            tag_name: release.tag_name,
            assets: release.assets.map(a => ({ name: a.name, url: a.browser_download_url }))
          });

          const currentVersion = app.getVersion();
          const latestVersion = release.tag_name.replace('v', '');
          
          // Add proper version comparison
          const hasUpdate = compareVersions(currentVersion, latestVersion) < 0;
          
          // Find the Windows installer asset
          const windowsAsset = release.assets.find(asset => 
            asset.name === 'J5PMS-setup.exe'
          );

          if (!windowsAsset && release.assets.length > 0) {
            console.log('Available assets:', release.assets.map(a => a.name).join(', '));
            logError('No suitable Windows installer found in release assets');
            throw new Error('Installer not found in release assets. Available assets: ' + 
              release.assets.map(a => a.name).join(', '));
          }

          const updateInfo = {
            hasUpdate,
            currentVersion,
            latestVersion,
            downloadUrl: windowsAsset ? windowsAsset.browser_download_url : null,
            releaseNotes: release.body || 'No release notes available',
            releaseName: release.name || `Version ${latestVersion}`,
            releaseDate: new Date(release.published_at).toLocaleDateString()
          };

          console.log('Update check result:', {
            hasUpdate: updateInfo.hasUpdate,
            currentVersion: updateInfo.currentVersion,
            latestVersion: updateInfo.latestVersion,
            downloadUrl: updateInfo.downloadUrl
          });

          resolve(updateInfo);
        } catch (err) {
          console.error('Error parsing update response:', err);
          reject(err);
        }
      });
    });

    req.on('error', (error) => {
      console.error('Update check error:', error);
      logError(`Update check error: ${error.message}`);
      reject(error);
    });

    req.end();
  });
}

// Add this helper function for semantic version comparison
function compareVersions(v1, v2) {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    if (v1Parts[i] > v2Parts[i]) return 1;
    if (v1Parts[i] < v2Parts[i]) return -1;
  }
  return 0;
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Exit',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Settings',
      click: () => {
        controlPanel.webContents.send('show:settings');
      }
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Instructions',
          click: () => {
            controlPanel.webContents.send('show:instructions');
          }
        },
        {
          label: 'About',
          click: () => {
            controlPanel.webContents.send('show:about');
          }
        },
        {
          label: 'Developers',
          click: () => {
            controlPanel.webContents.send('show:developers');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createSplashScreen() {
  const iconPath = path.join(__dirname, 'icons', 'icon.ico');
  
  splashScreen = new BrowserWindow({
    width: 500,
    height: 300,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: iconPath
  });

  // Set the app icon for the taskbar/dock
  if (process.platform === 'win32') {
    splashScreen.setIcon(iconPath);
    // Force a refresh of the taskbar icon
    splashScreen.setSkipTaskbar(true);
    setTimeout(() => {
      splashScreen.setSkipTaskbar(false);
    }, 100);
  }

  splashScreen.loadFile(path.join(__dirname, 'splash.html'));
  splashScreen.center();
}

function createControlPanel() {
  try {
    const iconPath = path.join(__dirname, 'icons', 'icon.ico');
    console.log('Loading icon from:', iconPath);
    console.log('Icon exists:', fs.existsSync(iconPath));

    // Set app icon for Windows
    if (process.platform === 'win32') {
      try {
        app.setAppUserModelId(process.execPath);
      } catch (err) {
        console.error('Failed to set AppUserModelId:', err);
      }
    }

    // 16:9 ratio with 1280px width
    controlPanel = new BrowserWindow({
      width: 1280,
      height: 720,
      minWidth: 1280,
      minHeight: 720,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true
      },
      title: 'PMS Backend Support',
      icon: iconPath,
      show: false  // Don't show until ready
    });

    // Set the app icon for the taskbar/dock
    if (process.platform === 'win32') {
      controlPanel.setIcon(iconPath);
      // Force a refresh of the taskbar icon
      controlPanel.setSkipTaskbar(true);
      setTimeout(() => {
        controlPanel.setSkipTaskbar(false);
      }, 1000);
    }

    controlPanel.loadFile(path.join(__dirname, 'controlPanel.html'))
      .catch(err => logError(`Failed to load control panel: ${err}`));
    
    createMenu();

    // Once ready, maximize, show and close splash screen
    controlPanel.once('ready-to-show', () => {
      setTimeout(() => {
        controlPanel.maximize();
        controlPanel.show();
        if (splashScreen) {
          splashScreen.close();
          splashScreen = null;
        }
        createTray(); // Create tray icon after window is ready
      }, 5000); // Show splash for at least 2 seconds
    });

    if (isDev) {
      controlPanel.webContents.openDevTools();
    }

    controlPanel.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      logError(`Window failed to load: ${errorDescription} (${errorCode})`);
    });

    controlPanel.on('close', (e) => {
      if (serverRunning) {
        e.preventDefault();
        controlPanel.webContents.send('confirm:exit');
      }
    });

    controlPanel.on('closed', () => {
      stopServer();
      if (browserWindow) {
        browserWindow.close();
      }
      controlPanel = null;
    });

    // Check if server was running before reload
    if (loadServerState()) {
      startServer();
    }

    require('@electron/remote/main').enable(controlPanel.webContents);

    // Add these event listeners after controlPanel is created
    controlPanel.on('minimize', (e) => {
      if (minimizeToTray) {
        e.preventDefault();
        controlPanel.hide();
        showTrayNotification('PMS Backend Support is running in the background');
      }
    });

    // Add the close event handler here
    controlPanel.on('close', (e) => {
      if (serverRunning) {
        e.preventDefault();
        controlPanel.webContents.send('confirm:exit');
      }
    });
  } catch (err) {
    logError(`Failed to create control panel: ${err}`);
  }
}

function createBrowserWindow() {
  browserWindow = new BrowserWindow({
    width: 1280,
    height: 1024,
    webPreferences: {
      nodeIntegration: false
    },
    show: false,
    icon: path.join(__dirname, 'icons', process.platform === 'win32' 
      ? 'icon.ico' 
      : process.platform === 'darwin'
      ? 'icon.icns'
      : 'icon.png')
  });

  browserWindow.loadURL('https://pms.j5pharmacy.com');
  browserWindow.maximize();

  browserWindow.on('closed', () => {
    browserWindow = null;
  });
}

function getServerPath() {
  return path.join(getAppPath(), 'server.js');
}

// Add this function to handle .env in production
function loadEnvConfig() {
  try {
    const envPath = isDev 
      ? path.join(__dirname, '..', '.env')
      : path.join(process.resourcesPath, '.env');
    
    console.log('Loading .env from:', envPath);
    
    if (fs.existsSync(envPath)) {
      const envConfig = dotenv.parse(fs.readFileSync(envPath));
      Object.keys(envConfig).forEach(key => {
        process.env[key] = envConfig[key];
      });
      console.log('Environment variables loaded successfully');
    } else {
      console.error('.env file not found at:', envPath);
    }
  } catch (err) {
    console.error('Error loading .env:', err);
  }
}

function startServer() {
  try {
    if (serverProcess) return;

    const serverPath = getServerPath();
    console.log('Starting server from:', serverPath);
    
    // Load environment variables before starting server
    loadEnvConfig();
    
    if (!fs.existsSync(serverPath)) {
      logError(`Server file not found: ${serverPath}`);
      if (controlPanel) {
        controlPanel.webContents.send('server:log', `Error: Server file not found`);
      }
      return;
    }

    serverProcess = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: isDev ? 'development' : 'production',
        PATH: process.env.PATH
      }
    });

    // Add error handlers
    serverProcess.on('error', (error) => {
      logError(`Server process error: ${error.message}`);
      if (controlPanel) {
        controlPanel.webContents.send('server:log', `Error: ${error.message}`);
      }
    });

    serverProcess.stdout.on('data', (data) => {
      const logMessage = `Server: ${data}`;
      if (controlPanel) {
        controlPanel.webContents.send('server:log', logMessage);
      }
      console.log(logMessage);
      
      if (data.includes('Server is running')) {
        serverRunning = true;
        saveServerState(true);
        if (controlPanel) {
          controlPanel.webContents.send('server:started');
        }
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const errorMessage = `Server Error: ${data}`;
      if (controlPanel) {
        controlPanel.webContents.send('server:log', errorMessage);
      }
      console.error(errorMessage);
      logError(errorMessage);
    });

    serverProcess.on('close', (code) => {
      const message = `Server process exited with code ${code}`;
      serverRunning = false;
      if (controlPanel) {
        controlPanel.webContents.send('server:stopped');
        controlPanel.webContents.send('server:log', message);
      }
      if (code !== 0) {
        logError(message);
      }
    });
  } catch (err) {
    logError(`Failed to start server: ${err}`);
  }
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
    serverRunning = false;
    saveServerState(false);
  }
}

// Debug function to list directory contents
function listDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    console.log(`Contents of ${dir}:`, files);
    if (controlPanel) {
      controlPanel.webContents.send('server:log', `Contents of ${dir}: ${files.join(', ')}`);
    }
  } catch (err) {
    console.error(`Error listing directory ${dir}:`, err);
    if (controlPanel) {
      controlPanel.webContents.send('server:log', `Error listing directory ${dir}: ${err.message}`);
    }
  }
}

// Start automatic update checking
function startAutoUpdateCheck() {
  // Load environment variables if not already loaded
  if (!process.env.GITHUB_TOKEN) {
    loadEnvConfig();
  }

  // Load previous update state
  const updateState = loadUpdateState();
  updatePostponeCount = updateState.postponeCount || 0;

  // Check for updates every 30 minutes
  const CHECK_INTERVAL = 30 * 60 * 1000;
  
  // Initial check on startup (after a 30-second delay)
  setTimeout(async () => {
    await checkForUpdatesAndNotify();
  }, 30000);

  // Set up periodic checks
  updateCheckInterval = setInterval(async () => {
    await checkForUpdatesAndNotify();
  }, CHECK_INTERVAL);
}

// Stop automatic update checking
function stopAutoUpdateCheck() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}

// Check for updates and notify if available
async function checkForUpdatesAndNotify() {
  try {
    const updateInfo = await checkForUpdates();
    if (controlPanel && updateInfo.hasUpdate) {
      pendingUpdate = updateInfo;
      
      if (updateInfo.isCritical || updatePostponeCount >= MAX_POSTPONE_COUNT) {
        controlPanel.webContents.send('update:critical', {
          ...updateInfo,
          forceUpdate: true,
          reason: updateInfo.isCritical ? 'Critical security or stability update' : 'Update postponed too many times'
        });
      } else {
        controlPanel.webContents.send('update:status', 
          `Update available! Current: v${updateInfo.currentVersion}, Latest: v${updateInfo.latestVersion}`);
        controlPanel.webContents.send('update:available', updateInfo);
      }
    }
  } catch (err) {
    logError(`Auto update check failed: ${err.message}`);
    if (controlPanel) {
      // Show more user-friendly error messages
      if (err.message.includes('token has expired')) {
        controlPanel.webContents.send('update:status', 
          'Unable to check for updates. Please contact system administrator.');
      } else if (err.message.includes('rate limit exceeded')) {
        controlPanel.webContents.send('update:status', 
          'Too many update checks. Please try again later.');
      } else {
        controlPanel.webContents.send('update:status', 
          'Could not check for updates. Please try again later.');
      }
    }
  }
}

// Handle update postpone
function handleUpdatePostpone() {
  updatePostponeCount++;
  saveUpdateState({
    postponeCount: updatePostponeCount,
    lastPostponeTime: new Date().toISOString()
  });

  // If max postpone count reached, force update
  if (updatePostponeCount >= MAX_POSTPONE_COUNT && pendingUpdate) {
    controlPanel.webContents.send('update:critical', {
      ...pendingUpdate,
      forceUpdate: true,
      reason: 'Update postponed too many times'
    });
  }
}

// Reset update state after successful update
function resetUpdateState() {
  updatePostponeCount = 0;
  pendingUpdate = null;
  saveUpdateState({
    postponeCount: 0,
    lastPostponeTime: null
  });
}

// Add new function for system logs
function saveSystemLogs(logs, type = 'error') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${type}_log_${timestamp}.txt`;
  const logPath = isDev 
    ? path.join(__dirname, '..', 'logs', fileName)
    : path.join(app.getPath('userData'), 'logs', fileName);

  // Ensure logs directory exists
  const logsDir = path.dirname(logPath);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  fs.writeFile(logPath, logs, (err) => {
    if (err) {
      console.error('Failed to save logs:', err);
    } else {
      console.log(`Logs saved to: ${logPath}`);
      if (controlPanel) {
        controlPanel.webContents.send('logs:saved', logPath);
      }
    }
  });
  return logPath;
}

// Add network connectivity check
async function checkNetworkConnectivity() {
  try {
    // Try HTTP request first
    try {
      await new Promise((resolve, reject) => {
        const req = https.get('https://www.google.com', { timeout: 5000 }, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`HTTP status: ${res.statusCode}`));
          }
        });
        req.on('error', reject);
      });

      // If HTTP request succeeds, do ping test
      const res = await ping.promise.probe('8.8.8.8', {
        timeout: 2,
        min_reply: 1
      });

      return {
        connected: true,
        latency: res.alive ? res.time : 'unknown'
      };
    } catch (err) {
      console.log('HTTP check failed:', err);
      return {
        connected: false,
        latency: null
      };
    }
  } catch (err) {
    console.error('Network check error:', err);
    return {
      connected: false,
      latency: null
    };
  }
}

// Add this function to open logs folder
function openLogsFolder() {
  const logsPath = isDev 
    ? path.join(__dirname, '..', 'logs')
    : path.join(app.getPath('userData'), 'logs');

  if (!fs.existsSync(logsPath)) {
    fs.mkdirSync(logsPath, { recursive: true });
  }

  require('electron').shell.openPath(logsPath);
}

// Add these IPC handlers
ipcMain.on('save:systemLogs', (event, logs) => {
  const logPath = saveSystemLogs(logs, 'system');
  event.reply('logs:saved', logPath);
});

ipcMain.on('open:logs', () => {
  openLogsFolder();
});

ipcMain.on('check:network', async () => {
  const status = await checkNetworkConnectivity();
  if (controlPanel) {
    controlPanel.webContents.send('network:status', status);
  }
});

function createNodeCheckWindow() {
    nodeCheckWindow = new BrowserWindow({
        width: 600,
        height: 400,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        title: 'System Requirements Check'
    });

    nodeCheckWindow.loadFile(path.join(__dirname, 'nodeCheck.html'));
}

// Add these IPC handlers
ipcMain.on('check-node', () => {
    const result = checkNodeInstallation();
    nodeCheckWindow.webContents.send('node-check-result', result);
});

ipcMain.on('download-node', async () => {
    try {
        const installerPath = await downloadNodeInstaller();
        nodeCheckWindow.webContents.send('download-complete', installerPath);
    } catch (err) {
        nodeCheckWindow.webContents.send('download-error', err.message);
    }
});

ipcMain.on('run-installer', (event, installerPath) => {
    require('child_process').exec(installerPath);
});

ipcMain.on('proceed-installation', () => {
    nodeCheckWindow.close();
    createControlPanel();
});

app.on('ready', () => {
    createSplashScreen();
    createControlPanel();
    
    // Initial network check
    setTimeout(async () => {
        const status = await checkNetworkConnectivity();
        if (controlPanel) {
            controlPanel.webContents.send('network:status', status);
        }
    }, 1000);
});

app.on('window-all-closed', () => {
  stopServer();
  stopAutoUpdateCheck();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (controlPanel === null) {
    createControlPanel();
  }
});

// IPC handlers
ipcMain.on('server:start', () => {
  try {
    startServer();
  } catch (err) {
    logError(`Failed to handle server start: ${err}`);
  }
});

ipcMain.on('server:stop', () => {
  try {
    stopServer();
  } catch (err) {
    logError(`Failed to handle server stop: ${err}`);
  }
});

ipcMain.on('server:restart', () => {
  try {
    stopServer();
    setTimeout(() => startServer(), 1000);
  } catch (err) {
    logError(`Failed to handle server restart: ${err}`);
  }
});

ipcMain.on('open:browser', () => {
  if (serverRunning) {
    if (!browserWindow) {
      createBrowserWindow();
    }
    browserWindow.show();
    browserWindow.maximize();
    
    if (minimizeToTrayOnOpenBrowser) {
      controlPanel.hide();
      showTrayNotification('Application is running in the background');
    }
  }
});

ipcMain.on('update:postpone', () => {
  handleUpdatePostpone();
});

ipcMain.on('update:completed', () => {
  resetUpdateState();
});

ipcMain.on('check:update', async () => {
  try {
    const updateInfo = await checkForUpdates();
    if (controlPanel) {
      if (updateInfo.hasUpdate) {
        pendingUpdate = updateInfo;
        
        if (updateInfo.isCritical || updatePostponeCount >= MAX_POSTPONE_COUNT) {
          controlPanel.webContents.send('update:critical', {
            ...updateInfo,
            forceUpdate: true,
            reason: updateInfo.isCritical ? 'Critical security or stability update' : 'Update postponed too many times'
          });
        } else {
          controlPanel.webContents.send('update:status', 
            `Update available! Current: v${updateInfo.currentVersion}, Latest: v${updateInfo.latestVersion}`);
          controlPanel.webContents.send('update:available', updateInfo);
        }
      } else {
        controlPanel.webContents.send('update:status', 
          `Your app (v${updateInfo.currentVersion}) is up to date!`);
      }
    }
  } catch (err) {
    if (controlPanel) {
      controlPanel.webContents.send('update:status', 
        'Could not check for updates. Please try again later.');
    }
    logError(`Update check failed: ${err.message}`);
  }
});

// Add this function to check for Node.js installation
function checkNodeInstallation() {
  try {
    const nodeVersion = require('child_process').execSync('node --version').toString().trim();
    return { installed: true, version: nodeVersion };
  } catch (err) {
    return { installed: false, version: null };
  }
}

// Add this function to handle Node.js download
function downloadNodeInstaller() {
  const nodeUrl = 'https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi';  // LTS version
  return new Promise((resolve, reject) => {
    const https = require('https');
    const fs = require('fs');
    const downloadPath = path.join(app.getPath('downloads'), 'node-installer.msi');
    
    const file = fs.createWriteStream(downloadPath);
    https.get(nodeUrl, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(downloadPath);
      });
    }).on('error', (err) => {
      fs.unlink(downloadPath);
      reject(err);
    });
  });
}

// Email configuration for problem reports
function createEmailTransporter() {
    // Load environment variables if not already loaded
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
        loadEnvConfig();
    }

    // Double check if credentials are available
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
        console.error('Email credentials missing after loading config');
        return null;
    }

    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_APP_PASSWORD
        }
    });
}

// Handle problem report submission
async function sendProblemReport(reportData) {
    try {
        const transporter = createEmailTransporter();
        if (!transporter) {
            throw new Error('Email configuration is missing. Please check your .env file.');
        }

        // Test the connection
        await transporter.verify();
        console.log('Email connection verified');

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFileName = `problem_report_${timestamp}.txt`;
        const logPath = path.join(
            isDev ? path.join(__dirname, '..', 'logs') : app.getPath('userData'),
            'logs',
            logFileName
        );

        // Ensure logs directory exists
        const logsDir = path.dirname(logPath);
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Save the logs
        const logContent = `
Problem Report
-------------
Date: ${new Date().toLocaleString()}
Category: ${reportData.category}
Title: ${reportData.title}

Description:
${reportData.description}

System Logs:
${reportData.systemLogs}
        `;

        fs.writeFileSync(logPath, logContent);
        console.log('Problem report log saved to:', logPath);

        // Prepare email
        const mailOptions = {
            from: `"PMS Support" <${process.env.EMAIL_USER}>`,
            to: 'kevsllanes@gmail.com',
            subject: `[PMS Problem Report] ${reportData.title}`,
            text: `
A new problem has been reported in the PMS Backend Support application.

Category: ${reportData.category}
Title: ${reportData.title}

Description:
${reportData.description}

System logs are attached to this email.
            `,
            attachments: [
                {
                    filename: logFileName,
                    path: logPath
                }
            ]
        };

        // Add screenshots if any
        if (reportData.images && reportData.images.length > 0) {
            for (const image of reportData.images) {
                const imgBuffer = Buffer.from(image.data.split(',')[1], 'base64');
                mailOptions.attachments.push({
                    filename: image.name,
                    content: imgBuffer,
                    encoding: 'base64'
                });
            }
        }

        // Send email
        console.log('Attempting to send email...');
        await transporter.sendMail(mailOptions);
        console.log('Problem report email sent successfully');
        return { success: true, message: 'Problem report sent successfully' };
    } catch (error) {
        console.error('Error sending problem report:', error);
        logError(`Failed to send problem report: ${error.message}`);
        
        // Provide more specific error messages
        let errorMessage = 'Failed to send report: ';
        if (error.message.includes('Invalid login')) {
            errorMessage += 'Invalid email credentials. Please check your .env file.';
        } else if (error.message.includes('Missing credentials')) {
            errorMessage += 'Email configuration is missing. Please check your .env file.';
        } else if (error.message.includes('connect ETIMEDOUT')) {
            errorMessage += 'Connection timed out. Please check your internet connection.';
        } else {
            errorMessage += error.message;
        }
        
        return { 
            success: false, 
            message: errorMessage
        };
    }
}

// Add this IPC handler with the other handlers
ipcMain.on('submit:report', async (event, reportData) => {
    console.log('Received problem report submission');
    try {
        const result = await sendProblemReport(reportData);
        if (result.success) {
            event.reply('report:sent', result.message);
        } else {
            event.reply('report:error', result.message);
        }
    } catch (error) {
        console.error('Error in submit:report handler:', error);
        event.reply('report:error', `Error: ${error.message}`);
    }
});

// Add this function to download updates
async function downloadUpdate(downloadUrl) {
  const downloadPath = path.join(app.getPath('downloads'), 'J5PMS-setup.exe');
  console.log(`Starting download from URL: ${downloadUrl}`);
  console.log(`Download path: ${downloadPath}`);

  // Delete existing file if it exists
  if (fs.existsSync(downloadPath)) {
    try {
      fs.unlinkSync(downloadPath);
      console.log('Deleted existing installer file');
    } catch (err) {
      console.error('Failed to delete existing installer:', err);
    }
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(downloadPath);
    let receivedBytes = 0;

    const handleError = (err) => {
      console.error('Download error:', err);
      fs.unlink(downloadPath, () => {});
      reject(err);
    };

    // Direct download from the browser_download_url
    const request = https.get(downloadUrl, {
      headers: {
        'User-Agent': 'J5PH-Dev/control-panel',
        'Accept': '*/*'  // Accept any content type
      }
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        const redirectUrl = response.headers.location;
        console.log('Redirecting to:', redirectUrl);
        
        // Follow redirect
        https.get(redirectUrl, {
          headers: {
            'User-Agent': 'J5PH-Dev/control-panel',
            'Accept': '*/*'
          }
        }, (redirectResponse) => {
          const totalBytes = parseInt(redirectResponse.headers['content-length'], 10);
          
          redirectResponse.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (controlPanel) {
              const progress = (receivedBytes / totalBytes) * 100;
              controlPanel.webContents.send('update:download-progress', progress);
            }
          });

          redirectResponse.pipe(file);

          file.on('finish', () => {
            file.close();
            console.log('Download completed successfully');
            resolve(downloadPath);
          });
        }).on('error', handleError);
        
        return;
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download update: ${response.statusMessage} (${response.statusCode})`));
      }

      const totalBytes = parseInt(response.headers['content-length'], 10);
      
      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (controlPanel) {
          const progress = (receivedBytes / totalBytes) * 100;
          controlPanel.webContents.send('update:download-progress', progress);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log('Download completed successfully');
        resolve(downloadPath);
      });
    });

    request.on('error', handleError);
    request.end();
  });
}

// Add these IPC handlers for updates
ipcMain.on('update:download', async () => {
  try {
    if (!pendingUpdate || !pendingUpdate.downloadUrl) {
      const errorLog = `[${new Date().toLocaleTimeString()}] Update failed: No update available to download`;
      console.error(errorLog);
      if (controlPanel) {
        controlPanel.webContents.send('server:log', errorLog);
      }
      throw new Error('No update available to download');
    }

    const downloadLog = `[${new Date().toLocaleTimeString()}] Starting update download process. URL: ${pendingUpdate.downloadUrl}`;
    console.log(downloadLog);
    if (controlPanel) {
      controlPanel.webContents.send('server:log', downloadLog);
    }

    const installerPath = await downloadUpdate(pendingUpdate.downloadUrl);
    await installUpdate(installerPath);
  } catch (error) {
    const errorLog = `[${new Date().toLocaleTimeString()}] Update process failed: ${error.message}`;
    logError(errorLog);
    if (controlPanel) {
      controlPanel.webContents.send('server:log', errorLog);
      controlPanel.webContents.send('update:download-error', error.message);
    }
  }
});

// Add this function to install updates
async function installUpdate(installerPath) {
  try {
    // Stop the server before installing update
    stopServer();
    
    // Run the installer
    require('child_process').exec(installerPath, (error) => {
      if (error) {
        logError(`Failed to run installer: ${error}`);
        if (controlPanel) {
          controlPanel.webContents.send('update:install-error', error.message);
        }
      } else {
        // Quit the app to complete installation
        app.quit();
      }
    });
  } catch (error) {
    logError(`Failed to install update: ${error}`);
    throw error;
  }
} 

// Add this with other IPC handlers
ipcMain.on('app:quit', () => {
  if (controlPanel) {
    controlPanel.destroy(); // This bypasses the close event
  }
  app.quit();
}); 

function createTray() {
  const iconPath = path.join(__dirname, 'icons', 'icon.ico');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { if (controlPanel) controlPanel.show(); } },
    { type: 'separator' },
    { label: 'Start Server', click: () => { if (!serverRunning) startServer(); } },
    { label: 'Stop Server', click: () => { if (serverRunning) stopServer(); } },
    { label: 'Restart Server', click: () => { 
      stopServer();
      setTimeout(() => startServer(), 1000);
    }},
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ]);

  tray.setToolTip('J5 Pharmacy PMS Backend Support');
  tray.setContextMenu(contextMenu);
  
  // Add these event listeners after tray is created
  if (controlPanel) {
    controlPanel.on('minimize', () => {
      if (tray) {
        showTrayNotification('Application is running in the background');
      }
    });
  }
} 

// Add settings IPC handlers
ipcMain.on('settings:save', (event, settings) => {
  minimizeToTray = settings.minimizeToTray;
  minimizeToTrayOnOpenBrowser = settings.minimizeToTrayOnOpenBrowser;
});

function showTrayNotification(message) {
  if (tray) {
    const notification = new Notification({
      title: 'PMS Backend Support',
      body: message,
      icon: path.join(__dirname, 'icons', 'icon.ico'),
      silent: false
    });
    notification.show();
  }
} 