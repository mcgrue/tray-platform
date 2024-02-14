const { app, Menu, Tray } = require('electron')

export function setupTray() : Electron.CrossProcessExports.Tray {
    try {
        
        const appIcon = new Tray(__dirname + '/resources/tray-icon.png')
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Item1', type: 'radio' },
            { label: 'Item2', type: 'radio' }
        ]);
        
        // Make a change to the context menu
        contextMenu.items[1].checked = false
        
        // Call this again for Linux because we modified the context menu
        appIcon.setContextMenu(contextMenu)
        return appIcon;
    } catch(e) {
        debugger;
        console.error(e);
    }
}
