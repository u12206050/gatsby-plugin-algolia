
class Activity {
  constructor(title) {
    this.title = title
  }
  start() {
    this.st = this.lt = Date.now()
  }
  end() {
    console.log(`[${this.title}] Done in ${(Date.now() - this.st)/1000} s`)
  }
  t() {
    let lt = this.lt
    this.lt = Date.now()
    return (this.lt - lt)/1000
  }
  report(status) {
    console.log(`[${this.title}] ${status} - ${this.t()} ms`)
  }
  error(msg, error) {
    console.log(`[${this.title} ERROR] ${msg}`)
    console.log(error)
  }
}

module.exports = Activity