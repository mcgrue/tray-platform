



window['ipcComms'].onShowAlert((value) => {
  alert(value)
})

window['ipcComms'].onRefreshPage((value) => {
  location.reload();
})
