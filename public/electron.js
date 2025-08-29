const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { net } = require('electron');

let mainWindow;

// Function to check if a port is running our Angular app
async function checkAngularApp(port) {
  return new Promise((resolve) => {
    const request = net.request(`http://localhost:${port}`);
    
    request.on('response', (response) => {
      let data = '';
      
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        // Check for our app-specific markers
        const isOurApp = data.includes('app-root') && (
          data.includes('Markdown Editor') || 
          data.includes('markdown-editor-app') ||
          data.includes('MarkdownEditor')
        );
        resolve(isOurApp);
      });
    });
    
    request.on('error', () => {
      resolve(false);
    });
    
    // Set a timeout for the request
    setTimeout(() => {
      request.abort();
      resolve(false);
    }, 2000);
    
    request.end();
  });
}

// Function to find the correct Angular dev server port
async function findAngularDevServerPort() {
  const commonPorts = [4200, 4201, 4202, 4203, 4204, 4205, 4250];
  
  console.log('Searching for Angular dev server...');
  
  for (const port of commonPorts) {
    console.log(`Checking port ${port}...`);
    const isOurApp = await checkAngularApp(port);
    
    if (isOurApp) {
      console.log(`Found Angular dev server on port ${port}`);
      return port;
    }
  }
  
  console.warn('Could not find Angular dev server, defaulting to port 4200');
  console.warn('Make sure the Angular development server is running');
  return 4200;
}

async function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../src/assets/icon.png')
  });

  // Load the Angular app with dynamic port detection
  const isDev = process.env.NODE_ENV === 'development';
  let url;
  
  if (isDev) {
    const port = await findAngularDevServerPort();
    url = `http://localhost:${port}`;
    console.log(`Loading Angular app from: ${url}`);
    mainWindow.webContents.openDevTools();
  } else {
    url = path.join(__dirname, '../dist/index.html');
    console.log(`Loading production build from: ${url}`);
  }

  // Load the URL
  try {
    if (isDev) {
      await mainWindow.loadURL(url);
    } else {
      await mainWindow.loadFile(url);
    }
  } catch (error) {
    console.error('Failed to load application:', error);
    
    // If development mode fails, show an error dialog
    if (isDev) {
      dialog.showErrorBox(
        'Development Server Not Found',
        'Could not connect to the Angular development server.\n\n' +
        'Please make sure the Angular development server is running:\n' +
        'npm run ng serve\n\n' +
        'The application will now close.'
      );
      app.quit();
    }
  }

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App event handlers
app.whenReady().then(async () => {
  // Hide default menu
  Menu.setApplicationMenu(null);
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

// IPC handlers
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('select-folder-or-file', async () => {
  // Show file dialog that properly displays markdown files
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    defaultPath: process.cwd(),
    title: 'Select Markdown File',
    buttonLabel: 'Select File'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const selectedPath = result.filePaths[0];
    return {
      path: selectedPath,
      isDirectory: false
    };
  }
  
  return null;
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      console.error(`Attempted to read a directory: ${filePath}`);
      throw new Error('Cannot read a directory as a file');
    }
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  } catch (error) {
    console.error('Error reading file:', error);
    return '';
  }
});

ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    await fs.writeFile(filePath, content, 'utf-8');
    return true;
  } catch (error) {
    console.error('Error writing file:', error);
    return false;
  }
});

ipcMain.handle('save-file-as', async (event, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (!result.canceled && result.filePath) {
    try {
      await fs.writeFile(result.filePath, content, 'utf-8');
      return true;
    } catch (error) {
      console.error('Error saving file:', error);
      return false;
    }
  }
  return false;
});

ipcMain.handle('get-directory-contents', async (event, dirPath) => {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const contents = [];
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item.name);
      const isDirectory = item.isDirectory();
      const fileName = item.name.toLowerCase();
      
      // Include directories and markdown files (.md, .markdown extensions)
      const isMarkdownFile = fileName.endsWith('.md') || fileName.endsWith('.markdown');
      
      if (isDirectory || isMarkdownFile) {
        contents.push({
          name: item.name,
          path: itemPath,
          isDirectory: isDirectory
        });
      }
    }
    
    // Sort to show directories first, then files alphabetically
    contents.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    
    return contents;
  } catch (error) {
    console.error('Error reading directory:', error);
    return [];
  }
});

ipcMain.handle('create-new-file', async (event, defaultPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Create New Markdown File',
    defaultPath: defaultPath ? path.join(defaultPath, 'untitled.md') : 'untitled.md',
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (!result.canceled && result.filePath) {
    try {
      // Create the file with some default content
      const defaultContent = '# New Document\n\nStart writing your markdown here...\n';
      await fs.writeFile(result.filePath, defaultContent, 'utf-8');
      return {
        success: true,
        filePath: result.filePath,
        content: defaultContent
      };
    } catch (error) {
      console.error('Error creating new file:', error);
      return { success: false, error: error.message };
    }
  }
  return { success: false, cancelled: true };
});

ipcMain.handle('delete-file', async (event, filePath) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete File',
    message: 'Are you sure you want to delete this file?',
    detail: `This action cannot be undone.\n\nFile: ${path.basename(filePath)}`
  });
  
  if (result.response === 0) { // Delete button clicked
    try {
      await fs.unlink(filePath);
      return { success: true };
    } catch (error) {
      console.error('Error deleting file:', error);
      return { success: false, error: error.message };
    }
  }
  
  return { success: false, cancelled: true };
});
