const fs = require('fs');
const path = require('path');

console.log('Icon Conversion Helper');
console.log('=====================');
console.log('');
console.log('To fix the icon issue in your Electron app, you need to create the following icon files:');
console.log('');
console.log('1. For Windows (.ico format):');
console.log('   - Convert src/assets/icon.png to build/icon.ico');
console.log('   - Recommended sizes: 16x16, 32x32, 48x48, 64x64, 128x128, 256x256');
console.log('');
console.log('2. For macOS (.icns format):');
console.log('   - Convert src/assets/icon.png to build/icon.icns');
console.log('');
console.log('3. For Linux (.png format):');
console.log('   - Copy src/assets/icon.png to build/icon.png');
console.log('');
console.log('Icon Conversion Tools:');
console.log('=====================');
console.log('');
console.log('Option 1: Online converters');
console.log('- https://convertio.co/png-ico/');
console.log('- https://www.icoconverter.com/');
console.log('');
console.log('Option 2: Command line tools');
console.log('- ImageMagick: convert icon.png -define icon:auto-resize=256,64,48,32,16 icon.ico');
console.log('- FFmpeg: ffmpeg -i icon.png -vf scale=256:256 icon.ico');
console.log('');
console.log('Option 3: Install electron-icon-builder');
console.log('- npm install -g electron-icon-builder');
console.log('- electron-icon-builder --input=./src/assets/icon.png --output=./build --flatten');

// Check current build directory
const buildDir = path.join(__dirname, '..', 'build');
const srcIcon = path.join(__dirname, '..', 'src', 'assets', 'icon.png');

if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
    console.log('');
    console.log('✓ Created build directory');
}

if (fs.existsSync(srcIcon)) {
    const destIcon = path.join(buildDir, 'icon.png');
    fs.copyFileSync(srcIcon, destIcon);
    console.log('✓ Copied icon.png to build directory (for Linux)');
} else {
    console.log('✗ Source icon not found at: ' + srcIcon);
}

console.log('');
console.log('Next steps:');
console.log('1. Create build/icon.ico (for Windows)');
console.log('2. Create build/icon.icns (for macOS)');
console.log('3. Run: npm run build-electron');
