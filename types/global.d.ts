import assertType from 'assert'

//it's a kind of magic!
declare global {
  var assert: typeof assertType
}
