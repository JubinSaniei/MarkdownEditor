# Markdown Editor

A modern, feature-rich desktop markdown editor built with Angular and Electron. Provides a professional editing experience with multiple view modes, advanced search capabilities, and beautiful theming.

![Markdown Editor](src/assets/demo.gif)

*Professional markdown editing with VS Code-inspired dark theme*

## ✨ Features

### Core Functionality
- **📁 File-Based Workspace**: Add individual .md files to your workspace with folder grouping for organization
- **🔄 Multi-View Modes**: 
  - **👁 Preview Mode**: Live rendered markdown preview
  - **✎ Edit Mode**: Focused writing experience
  - **↔ Split Mode**: Side-by-side editing and preview with scroll sync
- **💾 File Operations**: 
  - Save and Save As functionality
  - Create new markdown files directly in the app
  - Delete files permanently with confirmation
  - Remove files from workspace without deleting
- **🏠 Workspace Persistence**: Remembers individual files and settings between sessions

### Advanced Features
- **🔍 Powerful Search**: 
  - Global search with Ctrl+F
  - F3/Shift+F3 navigation
  - Visual highlighting in both edit and preview modes
  - Real-time search results with match counter
- **🎨 Dual Theme System**:
  - 🌙 **Light Theme**: Clean, minimal design
  - 🌑 **Dark Theme**: VS Code-inspired with optimized lighter blue colors for better readability
- **⚡ Scroll Synchronization**: Seamless scroll sync between editor and preview in split mode
- **📱 Responsive Design**: Collapsible sidebar with smooth animations
- **🎯 Modern UI**: Contemporary design with smooth transitions
- **📁 Smart File Organization**: Automatic folder grouping with collapsible sections
- **🔧 Centralized Theme System**: Consistent theming across all components
- **📋 Enhanced Markdown Rendering**:
  - GitHub Flavored Markdown (GFM) support with proper tables
  - Syntax-highlighted code blocks with language labels
  - Responsive table rendering with horizontal scrolling
  - Smart text wrapping in code blocks to prevent horizontal scrollbars
  - Custom styling for blockquotes, lists, and inline code

## 🛠 Technology Stack

- **Frontend**: Angular 20+ with TypeScript
- **Desktop**: Electron for cross-platform desktop app  
- **Markdown**: Marked v16+ library for GitHub Flavored Markdown parsing and rendering
- **Styling**: SCSS with modern design system (CSS custom properties)
- **Fonts**: JetBrains Mono, Fira Code for code editing
- **Icons**: Custom application logo (logo.png)

## Getting Started

### Prerequisites

- Node.js (version 18 or higher)
- npm package manager

### Installation

1. Clone or download this repository
2. Navigate to the project directory
3. Install dependencies:
   ```bash
   npm install
   ```

### Development

#### Run in Browser (Angular only)
```bash
npm start
```
This starts the Angular development server at http://localhost:4200

#### Run as Electron App
```bash
npm run electron-dev
```
This starts both the Angular dev server and Electron app

### Building for Production

#### Build Angular App
```bash
npm run build
```

#### Build Electron Distribution
```bash
npm run dist
```
This runs the Angular production build and then `electron-builder` to create desktop distribution artifacts.

#### Alternative: Directly Run electron-builder
If you've already built the Angular app ( `npm run build` ) you can invoke the packager directly:
```bash
npx electron-builder --publish=never
```
You can also build only for your current platform/arch (auto-detected) or specify targets, for example:
```bash
npx electron-builder --win portable
```

#### Output Artifacts
Build outputs are written to the `dist-electron/` directory (configured in `package.json > build.directories.output`). After a successful Windows build you'll typically see:
- `MarkdownEditor-Setup.exe` (NSIS installer)
- `MarkdownEditor-Portable.exe` (portable no-install version)
- `win-unpacked/` (unzipped unpacked app directory useful for debugging)
- Supporting metadata files (e.g. `*.blockmap`, config yaml) depending on target

Run the app by either launching the portable executable directly or installing via the setup installer. During development you can continue to use `npm run electron-dev` for a live-reload experience.

To adjust targets (e.g., add macOS dmg, Linux AppImage) edit the `build` section in `package.json`.

## 🎯 Usage

### Getting Started
1. **📂 Add Files to Workspace**: Click "➕ Add File" to select individual .md files for your workspace
2. **📝 Create New Files**: Click "📄" to create new markdown files directly in the app
3. **📋 File Management**: 
   - Files are automatically grouped by their parent folders for organization
   - **Single-click** any file to open it for editing
   - Use action buttons (✖ to remove from workspace, 🗑️ to delete permanently)
4. **🔄 View Modes**: Toggle between Preview (👁), Edit (✎), and Split (↔) modes
5. **🎨 Theme**: Switch between Light (🌙) and Dark (🌑) themes
6. **💾 Save Options**: Use the save dropdown for Save or Save As operations

### Navigation & Editing
- **🔍 Search**: Press `Ctrl+F` to open search, use `F3`/`Shift+F3` to navigate results
- **📝 Editor**: Full-featured markdown editor with syntax highlighting
- **👀 Preview**: Live rendered markdown with GitHub Flavored Markdown support
  - **📊 Tables**: Full table support with borders, hover effects, and responsive design
  - **💻 Code Blocks**: Syntax highlighting with language labels and smart text wrapping
  - **📝 Typography**: Enhanced headings, blockquotes, lists, and inline code styling
- **⚡ Split Mode**: Synchronized scrolling between editor and preview
- **📱 Sidebar**: Click `◀` to collapse/expand the file explorer

## ⌨️ Keyboard Shortcuts

### File Operations
- `Ctrl+S` - Save current file  
- `Ctrl+Shift+S` - Save As dialog

### Search & Navigation  
- `Ctrl+F` - Open search bar
- `F3` - Next search result
- `Shift+F3` - Previous search result
- `Enter` - Next result (in search input)
- `Shift+Enter` - Previous result (in search input)
- `Escape` - Close search bar

### Interface & File Management
- Toggle view modes with the view mode button (👁/✎/↔)
- Toggle theme with the theme button (🌙/🌑)
- Collapse sidebar with `◀` button
- **Single-click** files to open them immediately
- **Enter** or **Space** on selected files to open
- **Delete** key to remove selected files from workspace
- **Escape** to clear file selection

## ⚙️ Configuration

The application automatically saves your settings including:
- **🏠 Workspace files**: Individual markdown files added to your workspace
- **🎨 Theme preference**: Light or dark theme selection
- **📱 UI state**: Sidebar collapsed/expanded state
- **👁 View mode**: Last selected view mode (preview/edit/split)
- **📁 Folder state**: Remembers which folder groups are expanded/collapsed

All settings persist between sessions using localStorage.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Troubleshooting

### Port Already in Use
If you see "Port 4200 is already in use", either:
- Stop other Angular development servers
- Choose a different port when prompted
- Or kill the process using that port

### Electron App Not Starting
Make sure all dependencies are installed:
```bash
npm install
```

### File System Access Issues
The app requires file system permissions to read/write markdown files. Make sure Electron has proper permissions on your system.
