import * as uuid from 'uuid/v4'
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Declaration, Flowchart, Testcase, TestData, ParamsMap, TypedParamsMap, State, PipeObj, StepObj, OutPortsMap, InPortsMap, gettype, equals } from './types'

function error(obj: any, message: string): boolean {
    const e = new Error()
    const frame = e.stack.split('\n')[2].replace(/^[^\(]*\(/, '').replace(/\)[^\)]*/, '').split(':')
    const line = (frame.length > 1) ? frame[frame.length - 2] : '-'
    const script = path.basename(__filename)
    throw new Error(`${script}@${line}: ${obj.toString()} => ${message}`)
}

function debug(obj: any, message: string): boolean {
    const e = new Error()
    const frame = e.stack.split('\n')[2].replace(/^[^\(]*\(/, '').replace(/\)[^\)]*/, '').split(':')
    const line = (frame.length > 1) ? frame[frame.length - 2] : '-'
    const script = path.basename(__filename)
    console.log(`${script}@${line}: ${obj.toString()} => ${message}`)
    return true
}

function bodyfunc(type: string, strvalue: string): string {
    const cleanstr = strvalue.replace(/\`/, '${"`"}')
    let body = `
        let raw = '';
        try {
            raw = String.raw\`${cleanstr}\`
            return type.fromString(raw)
        } catch(e) { 
            throw(new Error(\`evaluation of "${strvalue}" of type "${type}" fails due to => \\n    $\{e.message}\`)) 
        }
    `;
    return body;
}

function argfunc(type: string, strvalue: string): Function {
    const body = bodyfunc(type, strvalue)
    return new Function('type', body);
}

function globfunc(type: string, strvalue: string): Function {
    const body = bodyfunc(type, strvalue)
    return new Function('args', 'globs', 'type', body);
}

function paramfunc(type: string, strvalue: string): Function {
    const body = bodyfunc(type, strvalue)
    return new Function('args', 'globs', 'params', 'pojo', 'type', body);
}

let DEBUG = false;
let COUNT = false;
let REPORT = false;

const SOP = 'SOP';  // Start Of Pojos
const EOP = 'EOP';  // End Of Pojos

type TypeStep = { new(params: ParamsMap): Step; declaration: Declaration; }
const REGISTRY: { [key: string]: TypeStep } = {}


/**
 * class defining a batch to run in cloud engine factory
 * @member batch the js plain object description
 * @member steps all the steps of this batch
 * @member globs globals variables for this batch
 * @member argv collected arguments from either process.argv or env variables
 */
class Batch {

    private _flowchart: Flowchart
    private _steps = new Map<string, Step>()
    private _globs: any = {}
    private _args: any = {}
    private _startdate: Date
    private _enddate: Date

    constructor(flowchart: Flowchart) {
        this._flowchart = flowchart
        DEBUG = process.argv.some((arg) => /^--DEBUG$/i.test(arg))
        COUNT = process.argv.some((arg) => /^--COUNT$/i.test(arg))
        REPORT = process.argv.some((arg) => /^--REPORT$/i.test(arg))
        // !!! eviter de faire des action supplementaire ici sinon valider avec Testbed 
    }
    get startdate() { return this._startdate }
    get enddate() { return this._enddate }
    get flowchart() { return this._flowchart }
    get steps() { return this._steps }
    get globs() { return this._globs }
    get args() { return this._args }
    toString() { return `[Batch: ${this._flowchart.title}]`; }
    error(message: string) { error(this, message) }

    public validate(): string[] {
        const errors: string[] = []
        const stepmap: Map<string,Declaration> = new Map()
        // validate parameters step 
        this._flowchart.steps.forEach(stepobj => {
            const aclass = Batch.load(stepobj.gitid)
            const decl:Declaration = aclass.declaration
            if (stepmap.has(stepobj.id)) {
                errors.push(`step id "${stepobj.id}" already used in this flowchart`)
            } else {
                stepmap.set(stepobj.id,decl) 
            }
            Object.keys(stepobj.params).forEach(name => decl.parameters[name] || errors.push(`step id "${stepobj.id}" parameter "${name}" doesn't exists in "${decl.gitid}"`) )
        })
        // validate pipe connections to steps 
        this._flowchart.pipes.forEach(pipeobj => {
            const fromdecl = stepmap.get(pipeobj.from)
            const todecl = stepmap.get(pipeobj.to)
            if (!fromdecl) {
                errors.push(`pipe "[>>>${pipeobj.from}<<</${pipeobj.outport} ==> ${pipeobj.to}/${pipeobj.inport}]" from step not found in this flowchart`)
            } else {
                if (!fromdecl.outputs[pipeobj.outport]) {
                    errors.push(`pipe "[${pipeobj.from}/>>${pipeobj.outport}<<< ==> ${pipeobj.to}/${pipeobj.inport}]" output port not found in step declaration ${fromdecl.gitid}`)
                }
            }
            if (!todecl) {
                errors.push(`pipe "[${pipeobj.from}/${pipeobj.outport} ==> >>>${pipeobj.to}<<</${pipeobj.inport}]" to step not found in this flowchart`)
            } else {
                if (!todecl.inputs[pipeobj.inport]) {
                    errors.push(`pipe "[${pipeobj.from}/>>${pipeobj.outport}<<< ==> ${pipeobj.to}/${pipeobj.inport}]" input port not found in step declaration ${todecl.gitid}`)
                }
            }
        })
        return errors
    }
    private initargs() {
        const argv: any = {};
        // default value in batch declaration
        Object.keys(this._flowchart.args).forEach(name => {
            const type = this._flowchart.args[name].type
            const value = this._flowchart.args[name].value
            argv[name] = argfunc(type, value)
        })
        // then env variables
        Object.keys(this._flowchart.args).forEach(name => {
            if (process.env[name]) {
                const type = this._flowchart.args[name].type
                const value = process.env[name]
                argv[name] = argfunc(type, value);
            }
        })
        // then process parameters
        process.argv.forEach((arg, i) => {
            if (i < 2) return; // skip 'node.exe' and 'script.js'
            if (/^--.*=.*$/.test(arg)) {
                const [name, value] = arg.replace(/^--?/, '').split(/=/)
                if (this._flowchart.args[name]) {
                    const type = this._flowchart.args[name].type
                    if (name in this._flowchart.args) {
                        argv[name] = argfunc(type, value);
                    }
                }
            }
        })
        argv['POJOE_TEMP_DIR'] = process.env['POJOE_TEMP_DIR'] || os.tmpdir()
        this._args = new Proxy(argv, {
            get: (target, property) => {
                try {
                    let argdef = this._flowchart.args[property.toString()]
                    argdef || this.error(`unknown argument variable "${property.toString()}" used`)
                    let type = gettype(argdef.type)
                    return target[property](type);
                } catch (e) {
                    this.error(`error "${e.message}" when evaluating arg parameter "${String(property)}"`);
                }
            },
        });

    }

    private initglobs() {
        // prepare lazy evaluation of parameters for each pojo
        const globs: any = {};
        Object.keys(this._flowchart.globs).forEach(name => {
            const type = this._flowchart.globs[name].type
            const value = this._flowchart.globs[name].value
            globs[name] = globfunc(type, value);
        });

        this._globs = new Proxy(globs, {
            get: (target, property) => {
                let globdef = this._flowchart.globs[property.toString()]
                globdef || this.error(`unknown global variable "${property.toString()}" used`)
                let type = gettype(globdef.type)
                try {
                    return target[property](this._args, this.globs, type);
                } catch (e) {
                    this.error(`error "${e.message}" when evaluating global parameter "${String(property)}" due to =>\n    ${e.message}`);
                }
            },
        });
    }

    public static load(gitid:string): TypeStep {
        let aclass = REGISTRY[gitid]
        if (!module) {
            // gitid is formed : <gitaccount>/<gitrepo>/steps/<step class name>
            const items = gitid.split('/')
            items.shift()
            const globpath = items.join('/')
            try {
                // for production mode modules install in node_modules
                module = require(globpath)
            } catch (e) {
                error(this, `unable to locate step "${gitid}"  module searched with ${globpath}`)
            }
        }
        return REGISTRY[gitid]
    }
    /**
     * method to add a step to this batch
     * @param {Step} step: a step to add to this batch
     */
    private initsteps() {
        // construct all steps 
        this._flowchart.steps.forEach(stepobj => {
            const aclass = Batch.load(stepobj.gitid)
            const step: Step = new aclass(stepobj.params)
            step.initparams(this.args, this.globs)
            this._steps.set(stepobj.id, step)
        })

        // connect all steps 
        this._flowchart.pipes.forEach((pipeobj, i) => {
            const step = this._steps.get(pipeobj.from)
            step || error(this, `unknown from step "${pipeobj.from}" in flowchart pipes no ${i}`);
            const target = this._steps.get(pipeobj.to)
            target || error(this, `unknown to step "${pipeobj.to}" in flowchart pipes no ${i}`);
            const outport = step.outport(pipeobj.outport)
            outport || error(this, `unknown outport "${pipeobj.outport}" in flowchart pipes no ${i}`);
            const inport = target.inport(pipeobj.inport)
            inport || error(this, `unknown inport "${pipeobj.inport}" in flowchart pipes no ${i}`);
            step.connect(outport, inport, (f: any) => f)
        })
    }
    private logcounts(timed = false) {
        const now = new Date()
        let duration:number
        timed && (duration = Math.floor(this.enddate.getTime()/1000 - this.startdate.getTime()/1000))
        timed && console.log(`--- ${this.flowchart.title} -------------------------------------------------`)
        timed && console.log(`duration: ${duration} sec. start:${this.startdate.toISOString()} end:${this.enddate.toISOString()}` )
        this.steps.forEach(step => {
            const inlog = step.inports.length ? `IN[ ${step.inports.map(port => port.name+'='+port.count).join(' , ')} ]` : ''
            const outlog = step.outports.length ? `OUT[ ${step.outports.map(port => port.name+'='+port.count).join(' , ')} ]` : ''
            console.log(`${now.toISOString()} : ${step.decl.gitid.split('/')[3]} ${inlog} ${outlog}`)
        })
        timed && console.log(`--- ${this.flowchart.title} -------------------------------------------------`)
    }
    async run(stepscb?: (steps: Step[]) => void) {
        let timeout: NodeJS.Timeout
        this._startdate = new Date()
        const errors = this.validate()
        if (errors.length) {
            errors.forEach(error => console.error(`FLOWCHART ERROR: ${error}`))
        }

        COUNT && (timeout = setInterval(this.logcounts.bind(this) ,10000))
        DEBUG && debug(this, `Starting batch => ${this._flowchart.title} @pid: ${process.pid}`)
        DEBUG && debug(this, `initialising arguments`)
        this.initargs()
        DEBUG && debug(this, `initialising globals`)
        this.initglobs()
        DEBUG && debug(this, `initialising steps`)
        this.initsteps()

        const steps = Array.from(this._steps.values())
        try {
            stepscb && stepscb(steps)
        } catch (e) {
            this.error(`onstart callback error due to => \n    ${e.message}`)
        }
        DEBUG && debug(this, `executing all the batch's steps `)
        let promises: Promise<any>[] = []
        for (let step of steps) {
            promises.push(step.exec())
        }
        await Promise.all(promises)
        this._enddate = new Date()
        COUNT && clearInterval(timeout)
        REPORT && this.logcounts(true)
    }
}

type ResFunc = (value?: any | Promise<any>) => void
type RejFunc = (reason?: any) => void
type RState = { fd: number, filepos: number, read: number, done: boolean, waiting: boolean, resolve: ResFunc, reject: RejFunc, lasts: Buffer[], fifo: string[]}
type WState = { fd: number, filepos: number, written: number,done: boolean, waiting: boolean, resolve: ResFunc, reject: RejFunc }
// async synchronisation beewteen a unique writer and multiple reader 
// create a temporary file
class Pipe {
    readonly tmpfile = `${os.tmpdir()}/tmp-${uuid()}.jsons`
    private _towrite: number = 0
    readonly capacity = 20000
    private _consumed = 0
    private _readers: Map<InputPort, RState> = new Map()
    private _writer: WState = { fd: -1, filepos: 0 , written: 0, done: false, waiting: false, resolve: null, reject: null }

    get readended(): boolean {
        for (const [_, rstate] of this._readers) if (!rstate.done) return false
        return true
    }
    get writeended(): boolean { return this._writer.done && this._writer.written >= this._towrite }
    get ended(): boolean { return this.writeended && this.readended }
    get hasreaders(): boolean { return this._readers.size > 0 }

    // private fwdread(rstate: RState, bytes: number): void {
    //     rstate.read++
    //     rstate.filepos += bytes;
    //     rstate.done = this.writeended && rstate.read >= this._towrite
    //     if (this.ended) fs.closeSync(this._writer.fd)
    // }
    private fwdwrite(wstate: WState, bytes: number): void {
        this._writer.written++
        this._writer.filepos += bytes
    }

    private open() {
        try {
            (this._writer.fd === -1) && (this._writer.fd = fs.openSync(this.tmpfile, 'w'))
            this._readers.forEach(reader => (reader.fd === -1) && (reader.fd = fs.openSync(this.tmpfile, 'r')))
        } catch (e) {
            error('Pipe', `unable to open for read/write tempfile "${this.tmpfile}" due to => \n    ${e.message}`)
        }
    }

    private close() {
        this._writer.done = true
        this.releasereaders()
    }


    private releasereaders() {
        // release all the waiting readers
        for (let [_, rstate] of this._readers) {
            if (rstate.waiting) {
                rstate.resolve()
                rstate.waiting = false
                rstate.resolve = null
                rstate.reject = null
            }
        }
    }

    private releasewriter() {
        // release the waiting writer
        if (this._writer.waiting) {
            this._writer.resolve()
            this._writer.waiting = false
            this._writer.resolve = null
            this._writer.reject = null
        }
    }

    private write(wstate: WState, pojo: any, resolve: ResFunc, reject: RejFunc) {
        // one capacity consumed
        this._consumed++
        // calculating json string and size to write
        const json = JSON.stringify(pojo) + '\n'
        // we must write len+json in same call to avoid separate write due to concurrency
        fs.write(this._writer.fd, json, this._writer.filepos, (err, bytes) => {
            if (err) return reject(new Error(`Pipe unable to write tempfile "${this.tmpfile}" due to  => \n    ${err.message}`))

            // return one capacity returned then release writer
            this._consumed--
            this.fwdwrite(wstate, bytes)
            this.releasewriter()

            // forward writer means data is provided then release readers
            this.releasereaders()
            resolve()
        })
    }

    private read(rstate: RState, resolve: ResFunc, reject: RejFunc) {
        let buf = Buffer.alloc(100000)
        if (rstate.fifo.length > 0) {
            // extract item from fifo
            const pojo = JSON.parse(rstate.fifo.shift())
            rstate.done = this.writeended && (rstate.fifo.length === 0) && (rstate.read >= this._towrite)
            if (this.ended) fs.closeSync(this._writer.fd)
            return resolve(pojo)
        }
        fs.read(rstate.fd, buf, 0, buf.byteLength, rstate.filepos, (err, bytes) => {
            if (err) return reject(new Error(`Pipe unable to read size object from file "${this.tmpfile}" due to => \n    ${err.message}`))
            rstate.filepos += bytes;
            let start = 0
            buf.forEach( (byte,end)=> {
                if (byte === 10) {
                    rstate.lasts.push(buf.slice(start,end))
                    const line = Buffer.concat(rstate.lasts).toString('utf8') 
                    rstate.fifo.push(line)
                    // forward reader data is consumed
                    rstate.read++
                    start = end + 1
                    rstate.lasts = []
                }
            })
            if (start <= bytes && bytes > 0) rstate.lasts.push(buf.slice(start,bytes))
            // continue reading until pojo pushed on fifo
            this.read(rstate,resolve,reject)
        })
    }

    private awaitreader(reader: InputPort, resolve: ResFunc, reject: RejFunc) {
        const rstate = this._readers.get(reader)
        rstate.waiting = true
        rstate.resolve = () => resolve(this.pop(reader))
        rstate.reject = reject
    }

    private awaitwriter(item: any, resolve: ResFunc, reject: RejFunc) {
        this._writer.waiting = true
        this._writer.resolve = () => resolve(this.push(item))
        this._writer.reject = reject
    }

    addreader(reader: InputPort) {
        this._readers.set(reader, { fd: -1, filepos: 0, read: 0, done: false, waiting: false, resolve: null, reject: null, fifo: [], lasts: [] })
    }
    isdone(port: InputPort) {
        return  this._readers.get(port).done
    }

    async pop(reader: InputPort): Promise<any> {
        const rstate = this._readers.get(reader)
        // reader terminated return EOP (End Of Pojos) 
        rstate.done = this.writeended && (rstate.fifo.length === 0) && (rstate.read >= this._towrite)
        if (rstate.done) return Promise.resolve(EOP)        
        return rstate && new Promise((resolve, reject) => {
            if ((this.writeended && this._towrite <= this._writer.written) // go on with reading no more awaitings
                || (rstate.read < this._writer.written)) // data ready ?
                // reader have items to read go read
                this.read(rstate, resolve, reject)
            else
                // wait for new data that will be ready after a write termination
                this.awaitreader(reader, resolve, reject)
        })
    }

    async push(item: any): Promise<any> {
        if (item === SOP) { this.open();  return; }
        if (item === EOP) { this.close(); return; }
        this._towrite++
        return new Promise((resolve, reject) => {
            // free capacity ?
            if (this._consumed < this.capacity) 
                // enough capacity go write
                this.write(this._writer, item, resolve, reject)
            else 
                // wait for capacity that will be released after a write termination
                this.awaitwriter(item, resolve, reject)
        })
    }
}

/**
 * class defining a port either an input port or an output port
 * port state is first idle
 * port state is started after receiving SOF (start of flow pojo)
 * port state is ended after receiving EOF (end of flow pojo)
 */
abstract class Port {
    readonly name: string;
    readonly step: Step;
    protected state: State = State.idle;
    protected _count = 0

    get count() { return this._count}
    get isinput(): boolean { return false };
    get isoutput(): boolean { return false };
    get isconnected(): boolean { return false };
    get isstarted() { return this.state === State.started }
    get isended() { return this.state === State.ended }
    get isidle() { return this.state === State.idle }

    constructor(name: string, step: Step) {
        this.name = name;
        this.step = step;
    }
    protected setState(pojo: any) {
        if (pojo === SOP && this.isidle) this.state = State.started;
        if (pojo === EOP && this.isstarted) this.state = State.ended;
    }
}

class OutputPort extends Port {
    readonly pipe: Pipe = new Pipe()
    get isoutput(): boolean { return true }
    get isconnected() {return this.pipe.hasreaders} 
    async put(pojo: any) {
        this.setState(pojo)
        await this.pipe.push(pojo).then(_ => pojo !== SOP && pojo !== EOP && this._count++).catch(e => Promise.reject(e))
        
    }
}

class InputPort extends Port {
    private pipes: Pipe[] = []
    private _eopcnt = 0
    get isinput(): boolean { return true };
    get isconnected() {return this.pipes.length > 0 } 
    constructor(name: string, step: Step) {
        super(name, step)
        this.state = State.started
    }
    from(pipe: Pipe) {
        pipe.addreader(this)
        this.pipes.push(pipe)
    }
    protected setState(pojo: any) {
        if (pojo === SOP && this.isidle) this.state = State.started;
        if (pojo === EOP && this.isstarted && ++this._eopcnt >= this.pipes.length) this.state = State.ended;
    }

    async get(): Promise<any> {
        let pojo = EOP
        for (let i = 0; i < this.pipes.length; i++) {
            if (!this.pipes[i].isdone(this)) {
                pojo = await this.pipes[i].pop(this)
                this.setState(pojo)
                if (pojo !== EOP) {
                    this._count++
                    return pojo
                }
            }
        }
        this.setState(pojo)
        return pojo;
    }
}

/**
 * @class Step 
 * extend this class to define the behavior of a new kind of step for the cloud batch
 * this class is used during execution time to process each step
 * @property id : step id
 * @property decl : the step declaration
 * @property batch : the batch containing this step
 * @property pipes : pipes output of this step
 * @property ports : input/output ports of this step
 * @property pojo : current pojo (available after first input)
 * @property params : parameters (dynamic see Proxy in constructor)
 */


abstract class Step {

    private _startdate: Date
    private _enddate: Date

    static register(aclass: TypeStep) {
        REGISTRY[aclass.declaration.gitid] = aclass
    }

    static getstep(stepid: string) {
        return REGISTRY[stepid]
    }
    protected readonly locals: { [key:string]: any } = {}

    readonly id = uuid()
    readonly decl: Declaration
    private _inports: { [key: string]: InputPort } = {}
    private _outports: { [key: string]: OutputPort } = {}
    private _pojo: any
    private _params: any = {}

    /**
     * start() method may be implemented by heriting classes
     * start() is called for a step at batch ignition
     */
    async start() {
        // default method do nothing
    }

    /**
     * end() method may be implemented by heriting classes
     * end() is called when step finished process()
     */
    async end() {
        // default method do nothing
    }

    /**
     * abstract input() method must be implemented by heriting classes
     * input() is called for each received pojo
     * @param inport input port name receiving the pojo
     * @param pojo the received pojo
     */
    async input(inport: string, pojo: any): Promise<any> {
        // default method do nothing with pojos received
    }

    //  
    // process() is called after all data inputs completed
    /**
     * abstract process() method must be implemented by heriting classes
     */
    async process(): Promise<any> {
        // default method do nothing
    }


    /**
     * constructor
     * @param decl declaration object for the step
     * @param params parameters expressions for the step
     * @param batch the batch containing this step
     */
    protected constructor(decl: Declaration, params: ParamsMap) {
        this.decl = decl
        Object.keys(decl.inputs).forEach(name => this._inports[name] = new InputPort(name, this))
        Object.keys(decl.outputs).forEach(name => this._outports[name] = new OutputPort(name, this))
        this._params = params;
    }
    get startdate() { return this._startdate }
    get enddate() { return this._enddate }
    get type() { return this.decl.gitid }
    get paramlist() { return Object.keys(this.decl.parameters) }
    get params(): any { return this._params }
    get inports(): InputPort[] { return Object['values'](this._inports) }
    get outports(): OutputPort[] { return Object['values'](this._outports) }
    get isinitial() { return this.inports.length === 0 }
    get isfinal() { return this.outports.length === 0 }
    outport(name: string): OutputPort { return this._outports[name] }
    inport(name: string): InputPort { return this._inports[name] }
    toString() { return `[Step: ${this.decl.gitid}]`; }
    isinport(portname: string) { return this._inports[portname] ? true : false }
    isoutport(portname: string) { return this._outports[portname] ? true : false }
    port(name: string): Port { return this._inports[name] || this._outports[name] }
    log(message: string) { console.log(message) }
    error(message: string) { error(this, message) }
    debug(message: string) { debug(this, message) }
    inconnected(port: string): boolean { return this._inports[port].isconnected ? true : false }
    outconnected(port: string): boolean { return this._outports[port] ? true : false }
    /**
     * initialize dynamic step parameter access
     * @param args: arguments map provided by the batch  
     * @param globs: globs map provided by the batch 
     */
    initparams(args: any, globs: any) {
        const paramsfn = {}
        this.paramlist.forEach(name => {
            !(name in this.decl.parameters) && error(this, `unknown parameter "${name}" it must be one of "${toString()}"`);
            paramsfn[name] = paramfunc(this.decl.parameters[name].type, this._params[name] || this.decl.parameters[name].default).bind(this.locals || {})
        });

        this._params = new Proxy(paramsfn, {
            get: (target, property) => {
                try {
                    let paramdef = this.decl.parameters[property.toString()]
                    paramdef || this.error(`unknown parameter "${property.toString()}" used`)
                    const type = gettype(paramdef.type)
                    return target[property](args, globs, this._params, this._pojo, type);
                } catch (e) {
                    error(this, `error when evaluating step parameter "${String(property)}" due to  => \n    "${e.message}" `);
                }
            },
        });
    }

    private async init() {
        for (let i = 0; i < this.outports.length; i++) {
            const outport = this.outports[i]
            await outport.put(SOP)
        }
    }
    private async terminate() {
        for (let i = 0; i < this.outports.length; i++) {
            const outport = this.outports[i]
            await outport.put(EOP)
        }
    }

    /**
     * dry up a port to receive all inputed data through a given port
     * @param port port to dry up
     */
    private async dryup(port: InputPort): Promise<any> {
        DEBUG && debug(this, `awaiting for input into port "${port.name}" `)
        let pojo = await port.get()
        if (pojo === EOP) return
        this._pojo = pojo
        DEBUG && debug(this, `pojo inputed on port "${port.name} pojo ${JSON.stringify(this._pojo).substr(0, 100)}" `)
        await this.input(port.name, pojo)
        DEBUG && debug(this, `pojo consumed on port "${port.name} pojo ${JSON.stringify(this._pojo).substr(0, 100)}" `)
        return this.dryup(port)
    }

    /**
     * dry up all ports to receive all inputed data through all ports
     * @param port port to dry up
     */
    private async pump() {
        const dryers = this.inports.map(port => this.dryup(port))
        return Promise.all(dryers)
    }

    /**
     * method to connect this step with a data pipe
     * @param outport name of the output port in this step
     * @param inport name of the input port in the target step
     * @param target target step of the pipe (where data flow)
     * @param filter filter function for flowing data
     */
    connect(outport: OutputPort, inport: InputPort, filter: (f: any) => boolean = f => true) {
        this.outports.indexOf(outport) >= 0 || error(this, `output port "${outport.name}" doesnt exists in this step trying to connect`)
        inport.from(outport.pipe);
    }

    /**
     * method to output a pojo throw the corresponding port
     * @param {string} outport: a port name
     * @param {any} pojo: the pojo to output
     */
    async output(outport: string, pojo: any) {
        const port = this._outports[outport]
        !port && error(this, `unknown output port  "${outport}".`);
        DEBUG && debug(this, `awaiting for output into port "${port.name} pojo ${JSON.stringify(pojo).substr(0, 100)}" `)
        await port.put(pojo)
        DEBUG && debug(this, `pojo outputed on port "${port.name} pojo ${JSON.stringify(pojo).substr(0, 100)}" `)
    }

    async exec() {
        this._startdate = new Date()
        DEBUG && debug(this, `init phase `)
        await this.init()
        DEBUG && debug(this, `start phase `)
        await this.start()
        DEBUG && debug(this, `pump phase `)
        await this.pump()
        DEBUG && debug(this, `process phase `)
        await this.process()
        DEBUG && debug(this, `end phase `)
        await this.end()
        DEBUG && debug(this, `terminate phase `)
        await this.terminate()
        this._enddate = new Date()
    }
}

class TestbedOutput extends Step {
    static readonly gitid = 'mbenzekri/pojoe/steps/TestbedOutput'
    static readonly declaration: Declaration = {
        gitid: TestbedOutput.gitid,
        title: 'output test pojos to the tested step',
        desc: 'this step inject all the provided test pojos into the tested step',
        inputs: {},
        outputs: { /* to be dynamicaly created at test initialisation */ },
        parameters: {
            'dataforinjection': { default: '${ JSON.stringify(globs.dataforinjection)}', type: 'json', title: 'data to inject into the step' }
        },
    };
    constructor() {
        super(TestbedOutput.declaration, {})
    }

    async process() {
        // output all the provided pojos for the test
        const data = this.params.dataforinjection
        for (let outport in this.decl.outputs) {
            if (data[outport]) {
                for (let i = 0; i < data[outport].length; i++) {
                    const pojo = data[outport][i]
                    await this.output(outport, pojo)
                }
            }
        }
    }
}

const TestbedInput_gitid = 'mbenzekri/pojoe/steps/TestbedInput'
const TestbedInput_declaration: Declaration = {
    gitid: TestbedInput_gitid,
    title: 'get pojos from the tested step and validate',
    desc: 'this step receives all the pojos of the tested step and validate them among the expected data',
    inputs: {/* to be dynamicaly created at test initialisation */ },
    outputs: {},
    parameters: {
        'dataforvalidation': { default: '${ JSON.stringify(globs.dataforvalidation)}', type: 'json', title: 'data to inject into the step' }
    },
}


class TestbedInput extends Step {
    static readonly gitid = TestbedInput_gitid
    static readonly declaration: Declaration = TestbedInput_declaration
    result: TestData = this.inports.reduce((prev, port) => { prev[port.name] = []; return prev }, {})
    constructor() {
        super(TestbedInput_declaration, {})
    }

    async input(inport: string, pojo: any) {
        this.result[inport].push(pojo)
    }

    async process() {
        // checks equality with expected pojos

        const dataval: any[] = this.params.dataforvalidation
        const failed: string[] = [];
        for (let input in dataval) {
            const outputed = this.result[input] || []
            const expected = dataval[input] || []
            const isequal = equals(expected, outputed)
            if (!isequal) failed.push (`    ==> on port "${input}"
---------------- EXPECTED: \n${JSON.stringify(expected, undefined, 4)} 
---------------- OUTPUTED: \n${JSON.stringify(outputed, undefined, 4)} \n`)
        }
        if (failed.length)  this.error(`test failed due to outputed data !== expected data \n` + failed.join(''))
    }
}

Step.register(TestbedOutput)
Step.register(TestbedInput)

class Testbed extends Batch {
    static globs(globs1: TypedParamsMap, globs2: TypedParamsMap): TypedParamsMap {
        if (globs2) {
            Object.keys(globs2).forEach(name => {
                globs1[name] = globs2[name]
            })
        }
        return globs1
    }
    static pipes(stepid: string): PipeObj[] {
        const stepmod = REGISTRY[stepid]
        stepmod || error('Testbed', `${stepid} not registered`);
        const outpipes = Object.keys(stepmod.declaration.inputs).map(
            inport => <PipeObj>{ from: 'testbedoutput', outport: inport, to: 'testtostep', inport: inport }
        )
        const inpipes = Object.keys(stepmod.declaration.outputs).map(
            outport => <PipeObj>{ from: 'testtostep', outport: outport, to: 'testbedinput', inport: outport }
        )
        const outdecl = REGISTRY[TestbedOutput.gitid].declaration
        const indecl = REGISTRY[TestbedInput_gitid].declaration
        outdecl.outputs = Object.keys(stepmod.declaration.inputs).reduce((prev, port) => {
            prev[port] = { title: 'dynamic ouput test port' }
            return prev
        }, <OutPortsMap>{})
        indecl.inputs = Object.keys(stepmod.declaration.outputs).reduce((prev, port) => {
            prev[port] = { title: 'dynamic input test port' }
            return prev
        }, <InPortsMap>{})
        return outpipes.concat(inpipes)
    }
    static steps(stepid: string, params: ParamsMap): StepObj[] {
        return [
            { id: 'testbedoutput', gitid: TestbedOutput.gitid, params: {} },
            { id: 'testtostep', gitid: stepid, params: params },
            { id: 'testbedinput', gitid: TestbedInput_gitid, params: {} },
        ]
    }
    constructor(testcase: Testcase) {
        super({
            id: uuid(),
            title: `${testcase.title} =>  Testbed for step : ${testcase.stepid}`,
            desc: `${testcase.title} => Testbed for step : ${testcase.stepid}`,
            args: testcase.args || {},
            globs: Testbed.globs({
                "dataforvalidation": { type: 'json', value: JSON.stringify(testcase.expected), desc: '' },
                "dataforinjection": { type: 'json', value: JSON.stringify(testcase.injected), desc: '' },
            }, testcase.globs),
            steps: Testbed.steps(testcase.stepid, testcase.params),
            pipes: Testbed.pipes(testcase.stepid)
        })
    }
    static header(state: string, tested: Step) {
        console.log((`--- TEST ${state} ${tested.decl.gitid}---------------------------------------------------------------------------------------------------------`).substr(0,150))
    }

    static async run(tests: Testcase[], debug = false) {
        const fgred = "\x1b[31m"
        const fggreen = "\x1b[32m"
        const reset = "\x1b[0m"
        const results: string[] = []
        let tested: Step
        for (let i = 0; i < tests.length; i++) {
            try {
                const testcase = tests[i]
                Batch.load(testcase.stepid)
                const test = new Testbed(testcase)
                DEBUG = debug
                const errors = test.validate()
                if (errors.length) {
                    errors.forEach(error => results.push(`${fgred}TESTBED ERROR: ${error}${reset}`))
                }
                await test.run((steps: Step[]) => {
                    tested = steps.find(step => step.decl.gitid === testcase.stepid)
                    testcase.onstart && testcase.onstart(tested)
                })
                tested && testcase.onend && testcase.onend(tested)

                results.push(`${fggreen}SUCCESS: testing ${tested.decl.gitid} for ${tests[i].title}${reset}`);
            } catch (e) {
                results.push(`${fgred}FAILURE: testing ${tested.decl.gitid} for ${tests[i].title} due to => \n    ${e.message}${reset}`);
            }
        }
        DEBUG = false
        results.forEach(result => console.log(result))
    }

}

export {
    Declaration, Flowchart, Testcase, Batch, Testbed, Step, ParamsMap, SOP, EOP
};
