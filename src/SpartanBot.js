import { Account } from 'oip-account'
import uid from 'uid';
import moment from 'moment'
import EventEmitter from 'eventemitter3'
import {config} from 'dotenv'
config()

import { MRRProvider, NiceHashProvider } from './RentalProviders'
import { SpartanSenseStrategy, ManualRentStrategy, SpotRentalStrategy } from './RentalStrategies'
import AutoRenter from './AutoRenter'
import {
	RentalFunctionFinish,
	ManualRent,
	NORMAL,
	WARNING, RENTAL_SUCCESS, RENTAL_WARNING, RENTAL_ERROR, ERROR, SpotRental
} from "./constants";

var https = require('https')
const { info } = require("console");

const SUPPORTED_RENTAL_PROVIDERS = [ MRRProvider, NiceHashProvider ]
const SUPPORTED_RENTAL_STRATEGIES = [ SpartanSenseStrategy, ManualRentStrategy, SpotRentalStrategy ]

let localStorage

if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
	if (typeof localStorage === "undefined") {
		var LocalStorage = require('node-localstorage').LocalStorage;
		localStorage = new LocalStorage('./localStorage');
	}
} else {localStorage = window.localStorage}

let waitFn = async (time) => {
	setTimeout(() => { return }, time || 1000)
}

/**
 * Rent hashrate based on a set of circumstances
 */
class SpartanBot {
	/**
	 * Create a new SpartanBot
	 * @param  {Object} settings - The settings for the SpartanBot node
	 * @param {Boolean} [settings.memory=false] - Should SpartanBot only run in Memory and not save anything to disk
	 * @param {string} [settings.mnemonic] - Pass in a mnemonic to have the SpartanBot load your personal wallet
	 * @return {SpartanBot}
	 */
	constructor(settings){
		this.settings = settings || {}
		this.self = this

		this.rental_providers = []
		this.rental_strategies = {}

		this.pools = []
		this.poolProfiles = []
		this.receipts = []

		this.emitter = new EventEmitter()
		this.setupListeners()

		// Try to load state from LocalStorage if we are not memory only
		if (!this.settings.memory){

			this._deserialize = this.deserialize().then(() => {
				//check first to see if a mnemonic was passed in and load the wallet from there
				if (this.settings.mnemonic) {
					this.wallet = new Account(this.settings.mnemonic, undefined, {discover: false})
					//set mnemonic to undefined so it doesn't get serialize
					this.settings.mnemonic = undefined
					//wallet.login return promise
					this._wallet_login = this.wallet.login()
					//set the account identifier
					this._wallet_login.then((data) => {
						this.oip_account = data.identifier
						this.serialize()
					}).catch(err => {console.log('Error resolving wallet login: ', err)})

					// If we are not memory only, load the wallet using OIP Account
					// Check if the oip_account has been created
				} else if (this.oip_account){

					// Login to the wallet
					this.wallet = new Account(this.oip_account, undefined, {discover: false})
					this._wallet_login = this.wallet.login()
				} else {
					this.wallet = new Account(undefined, undefined, {discover: false})

					// Create and save wallet
					this._wallet_create = this.wallet.create().then((wallet_info) => {
						// Save the identifier to the localstorage
						this.oip_account = wallet_info.identifier
						this.serialize()
					})
				}
			})
		}
	}

	/**
	 * Setup event listeners for rental activity
	 */
	setupListeners() {
		this.emitter.on(RentalFunctionFinish, this.onRentalFnFinish.bind(this))
		this.emitter.on('error', (type, error) => {
			console.error(`There was an error in the ${type} event: `, error);
		});
		this.onRentalSuccess()
		this.onRentalWarning()
		this.onRentalError()
	}

	onRentalSuccess(onSuccess = (rental_info) => {console.log('Rental Success', rental_info)}) {
		this.emitter.off(RENTAL_SUCCESS)
		this.emitter.on(RENTAL_SUCCESS, onSuccess)
	}
	onRentalWarning(onWarning = (rental_info) => {console.log('Rental Warning', rental_info)}) {
		this.emitter.off(RENTAL_WARNING)
		this.emitter.on(RENTAL_WARNING, onWarning)
	}
	onRentalError(onError = (rental_info) => {console.log('Rental Error', rental_info)}) {
		this.emitter.off(RENTAL_ERROR)
		this.emitter.on(RENTAL_ERROR, onError)
	}

	onRentalFnFinish(rental_info) {
		console.log('rental function finished... saving rental_info')
		this.saveReceipt(rental_info)
		switch(rental_info.status) {
			case NORMAL:
				this.emitter.emit(RENTAL_SUCCESS, rental_info)
				break
			case WARNING:
				this.emitter.emit(RENTAL_WARNING, rental_info)
				break
			case ERROR:
				this.emitter.emit(RENTAL_ERROR, rental_info)
				break
			default:
				console.log('Rental info not of expected type!', rental_info)
		}
	}

	/**
	 * Setup a new Rental Strategy to auto-rent machines with.
	 * @return {Boolean} Returns `true` if setup was successful
	 */
	setupRentalStrategy(settings) {
		let rental_strategy

		for (let strategy of SUPPORTED_RENTAL_STRATEGIES){
			if (strategy.getType() === settings.type){
				rental_strategy = strategy
			}
		}

		if (!rental_strategy)
			throw new Error("No Strategy match found for `settings.type`!")

		let strat = new rental_strategy(settings)
		strat.onRentalTrigger(this.rent.bind(this))

		this.rental_strategies[strat.getInternalType()] = strat

		this.serialize()
	}

	/**
	 * Get all rental strategies or by individual type
	 * @param {String} [type] - 'ManualRent', 'SpotRental', 'SpartanSense', 'TradeBot
	 * @returns {Object} - If no type is given, will return all strategies
	 */
	getRentalStrategies(type) {
		if (type)
			return this.rental_strategies[type]
		return this.rental_strategies
	}

	/**
	 * Fire off a manual rent event
	 * @param  {Number} hashrate - The hashrate you wish to rent (in MegaHash)
	 * @param  {Number} duration - The number of seconds that you wish to rent the miners for
	 * @param  {Function} [rentSelector] - Pass in a function that returns a Promise to offer rent options to user
	 */
	manualRent(hashrate, duration, rentSelector) {
		if (!this.getRentalStrategies(ManualRent))
			this.setupRentalStrategy({type: ManualRent})

		let strat = this.getRentalStrategies(ManualRent)
		strat.manualRent(hashrate, duration, rentSelector)
	}

	/**
	 * Fire off an event to start calculating spot profitability
	 * @param {function} rentSelector - an async function that takes in two parameters, `preprocess_rent` and `options`. Use to select which rent option to go with.
	 * @param {boolean} [fullnode=false] - specify whether you want to spawn a full node to read from
	 */
	spotRental(rentSelector, fullnode = false) {
		if (!this.getRentalStrategies(SpotRental))
			this.setupRentalStrategy({type: SpotRental})

		let strat = this.getRentalStrategies(SpotRental)
		strat.spotRental(rentSelector, fullnode, this)
	}

	/**
	 * Rent
	 * @param  {Number} hashrate - The hashrate you wish to rent (in MegaHash)
	 * @param  {Number} duration - The number of seconds that you wish to rent the miners for
	 * @param  {Function} [rentSelector] - Pass in a function that returns a Promise to offer rent options to user
	 * @param  {Object} self - a reference to 'this', the SpartanBot class (needed because the reference is lost when using event emitters)
 	 * @private
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object that contains information about the rental request
	 */
	rent(hashrate, duration, rentSelector){
		this.autorenter = new AutoRenter({
			rental_providers: this.rental_providers
		})
		this.autorenter.rent({
			hashrate,
			duration,
			rentSelector
		}).then(rental_info => {
			this.emitter.emit(RentalFunctionFinish, rental_info)
		}).catch(err => {
			let rental_info = {status: ERROR, message: "Unable to rent using SpartanBot!", error: err}
			this.emitter.emit(RentalFunctionFinish, rental_info)
		})
	}

	/**
	 * Setup a new Rental Provider for use
	 * @param {Object} settings - The settings for the Rental Provider
	 * @param {String} settings.type - The "type" of the rental provider. Currently only accepts "MiningRigRentals".
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String|Number} [settings.api_id] - The API ID from the Rental Provider
	 * @param {String} [settings.api_secret] - The API Secret for the Rental Provider
	 * @param {String} settings.name - Alias/arbitrary name for the provider
	 * @return {Promise<Object>} Returns a promise that will resolve after the rental provider has been setup
	 */
	async setupRentalProvider(settings){
		// Force settings to be passed
		if (!settings.type){
			return {
				success: false,
				message: "settings.type is required!"
			}
		}
		if (!settings.api_key){
			return {
				success: false,
				message: "settings.api_key is required!"
			}
		}
		if (!settings.api_secret && !settings.api_id){
			return {
				success: false,
				message: "settings.api_secret or settings.api_id is required!"
			}
		}

		// Match to a supported provider (if possible)
		let provider_match
		for (let provider of SUPPORTED_RENTAL_PROVIDERS){
			if (provider.getType() === settings.type){
				provider_match = provider;
			}
		}

		// Check if we didn't match to a provider
		if (!provider_match){
			return {
				success: false,
				message: "No Provider found that matches settings.type"
			}
		}

		// Create the new provider
		let new_provider = new provider_match(settings)

		// Test to make sure the API keys work
		try {
			let authorized = await new_provider.testAuthorization()

			if (!authorized){
				return {
					success: false,
					message: "Provider Authorization Failed"
				}
			}
		} catch (e) {
			throw new Error("Unable to check Provider Authorization!\n" + e)
		}

		this.rental_providers.push(new_provider)

		if (settings.activePool) {
			new_provider.setActivePool(settings.activePool)
		}
		if (settings.activePoolProfile) {
			new_provider.setActivePoolProfile(settings.activePoolProfile)
		}
		if (settings.name) {
			new_provider.setName(settings.name)
		}

		let pools = [];
		let poolProfiles = []

		if (settings.type === "MiningRigRentals") {
			process.env.MRR_API_KEY = settings.api_key || settings.key
			process.env.MRR_API_SECRET = settings.api_secret || settings.id

			let profiles = [];
			try {
				let res = await new_provider.getPoolProfiles()
				if (res.success) {
					profiles = res.data
				}
			} catch (err) {
				profiles = `Could not fetch pools: \n ${err}`
			}

			let ids = []
			for (let profile of profiles) {
				ids.push({id: profile.id, name: profile.name})
			}
			poolProfiles = ids.slice(0, ids.length)

			new_provider.setPoolProfiles(ids)

			try {
				pools = await new_provider.getPools();
			} catch (err) {
				pools = [{success: false, message: 'pools not found', err}]
			}
			new_provider.setPools(pools)

			//if no active pool profile set, set it to the first one retrieved from the api
			if (!new_provider.returnActivePoolProfile()) {
				if (ids.length !== 0)
					new_provider.setActivePoolProfile(ids[0].id)
			}
		} else if (settings.type === "NiceHash") {
			process.env.NICEHASH_API_KEY = settings.api_key || settings.key
			process.env.NICEHASH_API_ID = settings.api_id || settings.id

			if (settings.pools) {
				new_provider.setPools(settings.pools)
			}
		}

		// Save new Provider
		this.serialize()

		// Return info to the user
		return {
			success: true,
			message: "Successfully Setup Rental Provider",
			type: settings.type,
			name: settings.name,
			uid: new_provider.uid,
			pools,
			poolProfiles,
			provider: new_provider
		}
	}

	/**
	 * Get all of the Supported Rental Providers that you can Setup
	 * @return {Array.<String>} Returns an array containing all the supported providers "type" strings
	 */
	getSupportedRentalProviders(){
		let supported_provider_types = []

		// Itterate through all supported rental providers
		for (let provider of SUPPORTED_RENTAL_PROVIDERS){
			// Grab the type of the provider
			let provider_type = provider.getType()

			// Check if we have already added the provider to the array
			if (supported_provider_types.indexOf(provider_type) === -1){
				// If not, add it to the array
				supported_provider_types.push(provider_type)
			}
		}

		// Return the Array of all Supported Rental Provider types
		return supported_provider_types
	}

	/**
	 * Get all Rental Providers from SpartanBot
	 * @return {Array.<MRRProvider>} Returns an array containing all the available providers
	 */
	getRentalProviders(){
		return this.rental_providers
	}

	/**
	 * Delete a Rental Provider from SpartanBot
	 * @param  {String} uid - The uid of the Rental Provider to remove (can be acquired by running `.getUID()` on a RentalProvider)
	 * @return {Boolean} Returns true upon success
	 */
	deleteRentalProvider(uid){
		if (!uid)
			throw new Error("You must include the UID of the Provider you want to remove")

		let new_provider_array = []

		for (let i = 0; i < this.rental_providers.length; i++){
			if (this.rental_providers[i].getUID() !== uid){
				new_provider_array.push(this.rental_providers[i])
			}
		}

		this.rental_providers = new_provider_array

		this.serialize()

		return true
	}

	/**
	 * Get all setting back from SpartanBot
	 * @return {Object} Returns an object containing all the available settings
	 */
	getSettings(){
		return JSON.parse(JSON.stringify(this.settings))
	}

	/**
	 * Get a setting back from SpartanBot
	 * @param  {String} key - The setting key you wish to get the value of
	 * @return {Object|String|Array.<Object>} Returns the value of the requested setting
	 */
	getSetting(key){
		return this.settings[key]
	}

	/**
	 * Set a setting
	 * @param {String} key - What setting you wish to set
	 * @param {*} value - The value you wish to set the setting to
	 */
	setSetting(key, value){
		if (key !== undefined && value !== undefined)
			this.settings[key] = value

		// Save the latest
		this.serialize()

		return true
	}

	/**
	 * Get the balance of the internal wallet
	 * @param  {Boolean} [fiat_value=false] - `true` if the balance should returned be in Fiat, `false` if the balance should be returned in the regular coin values
	 * @return {Promise}
	 */
	async getWalletBalance(fiat_value){
		if (!this.wallet)
			return {
				success: false,
				info: "NO_WALLET",
				message: "No wallet was found in SpartanBot, may be running in memory mode"
			}

		if (fiat_value)
			return await this.wallet.wallet.getFiatBalances(["flo"])
		else
			return await this.wallet.wallet.getCoinBalances(["flo"])
	}

	/**
	 * Withdraw funds from your internal wallet
	 * @param {String} options - passing of new address connecting to the HDMW sendPayment
	 */
	async withdrawFromWallet(options){
		if (!this.wallet)
			return {
				success: false,
				info: "NO_WALLET",
				message: "No wallet was found in SpartanBot, may be running in memory mode"
			}
		if (options)
			return await this.wallet.wallet.sendPayment(options)
	}

	/**
	 * Get pools
	 * @param {Array.<number>} [ids] - an array of pool ids
	 * @return {Array.<Object>} pools
	 */
	async getPools(ids) {
		if (this.getRentalProviders().length === 0) {
			throw new Error('No rental providers. Cannot get pools.')
		}
		if (typeof ids === 'number' && !Array.isArray(ids)) {
			return await this.getPool(ids)
		} else {
			let poolIDs = []
			let pools = [];
			for (let provider of this.getRentalProviders()) {
				let tmpPools = []
				try {
					tmpPools = await provider.getPools(ids)
				} catch (err) {
					throw new Error(`Failed to get pools: ${err}`)
				}
				for (let tmp of tmpPools) {
					if (!poolIDs.includes(tmp.id)) {
						poolIDs.push(tmp.id)
						pools.push(tmp)
					}
				}
			}
			return pools
		}
	}

	/**
	 * Get pool by id
	 * @param {string|number} id - ID of the pool you want to fetch
	 * @return {Object} pool
	 */
	async getPool(id) {
		if (typeof id !== 'number' || typeof id !== 'string') {
			throw new Error('Cannot get pool: id must be of type number or string')
		}
		let pools = []
		let poolIDs = []
		for (let provider of this.getRentalProviders()) {
			let tmpPool;
			try {
				tmpPool = await provider.getPool(id)
			} catch (err) {
				throw new Error(`Failed to get pool: ${err}`)
			}
			if (!poolIDs.includes(tmpPool.id)) {
				poolIDs.push(tmpPool.id)
				pools.push(tmpPool)
			}
		}
		return pools
	}

	/**
	 * Creates a pool that will be added to all providers
	 * @param {Object} options
	 * @param {string} options.algo - Algorithm ('scrypt', 'x11', etc)
	 * @param {string} options.host - Pool host, the part after stratum+tcp://
	 * @param {number} options.port - Pool port, the part after the : in most pool host strings
	 * @param {string} options.user - Your workname
	 * @param {string} [options.pass='x'] - Worker password
	 * @param {string|number} [options.location=0] - NiceHash var only: 0 for Europe (NiceHash), 1 for USA (WestHash) ;
	 * @param {string} options.name - Name to identify the pool with
	 * @param {number} options.priority - MRR var only: 0-4
	 * @param {string} [options.notes] - MRR var only: Additional notes to help identify the pool for you
	 * @async
	 * @return {Promise<Number>} - the local pool id generated for the pools
	 */
	async createPool(options) {
		options.id = uid()
		for (let p of this.getRentalProviders()) {
			try {
				await p.createPool(options)
			} catch (err) {
				throw new Error(`Failed to create pool: ${err}`)
			}
		}
		return options.id
	}

	/**
	 * Delete a pool
	 * @param {(number|string)} id - Pool id
	 * @returns {Promise<*>}
	 */
	async deletePool(id) {
		let poolDelete = []
		for (let p of this.getRentalProviders()) {
			let pools = p.returnPools();
			for (let pool of pools) {
				if (pool.id === id || pool.mrrID === id) {
					try {
						poolDelete.push(await p.deletePool(id))
					} catch (err) {
						throw new Error(err)
					}
				}
			}
		}
		for (let i = 0; i < poolDelete.length; i++) {
			if (!poolDelete[i].success) {
				return poolDelete[i]
			}
		}
		return {success: true, id, message: 'Deleted'};
	}

	/**
	 * Update a pool
	 * @param {(number|Array.<number>)} poolIDs - IDs of the pools you wish to update
	 * @param {string|number} id - pool id
	 * @param {Object} [options]
	 * @param {string} [options.type] - Pool algo, eg: sha256, scrypt, x11, etc
	 * @param {string} [options.name] - Name to identify the pool with
	 * @param {string} [options.host] - Pool host, the part after stratum+tcp://
	 * @param {number} [options.port] - Pool port, the part after the : in most pool host strings
	 * @param {string} [options.user] - Your workname
	 * @param {string} [options.pass] - Worker password
	 * @param {string} [options.notes] - Additional notes to help identify the pool for you
	 * @async
	 * @returns {Promise<Array.<Object>>}
	 */
	async updatePool(id, options) {
		let updatedPools = []
		for (let provider of this.getRentalProviders()) {
			let res;
			try {
				res = await provider.updatePool(id, options)
			} catch (err) {
				throw new Error(`Failed to update pool on RentalProvider.js: ${err}`)
			}
			let tmpObj = {}
			tmpObj.name = provider.getName()
			tmpObj.providerUID = provider.getUID()
			tmpObj.message = res.data ? res.data : res
			updatedPools.push(tmpObj)
		}
		return updatedPools
	}

	/**
	 * Set pools to the spartanbot local variable
	 */
	_setPools(pools) {
		this.pools = pools
	}

	/**
	 * Gather and Return the pools set in the RentalProvider's local variable, this.pools
	 * @return {Array.<Object>}
	 */
	returnPools() {
		if (this.getRentalProviders().length === 0) {
			this._setPools = []
			return []
		}
		let pools = []
		let poolIDs = []
		for (let provider of this.getRentalProviders()) {
			let tmpPools = provider.returnPools()
			for (let pool of tmpPools) {
				if (!poolIDs.includes(pool.id)) {
					poolIDs.push(pool.id)
					pools.push(pool)
				}
			}
		}
		this._setPools(pools)
		return pools
	}

	/**
	 * Create a pool profile
	 * @param {string} name - Name of the profile
	 * @param {string} algo - Algo (x11, scrypt, sha256)
	 * @async
	 * @returns {Promise<Object>}
	 */
	async createPoolProfile(name, algo) {
		let profiles = []
		for (let p of this.getRentalProviders()) {
			if (p.getInternalType() === "MiningRigRentals") {
				let res;
				try {
					res = await p.createPoolProfile(name, algo)
				} catch (err) {
					throw new Error(`Failed to create pool profile: ${err}`)
				}
				if (res.success) {
					let modifiedProfile = {...res.data, uid: p.getUID()}
					profiles.push(modifiedProfile)
					p.addPoolProfiles(modifiedProfile)
				}
			}
		}
		this.returnPoolProfiles()
		return profiles
	}

	/**
	 * Delete a pool profile
	 * @param id
	 * @returns {Promise<Object>}
	 */
	async deletePoolProfile(id) {
		if (this.getRentalProviders().length === 0) {
			return {success: false, message: 'No providers'}
		}

		for (let p of this.getRentalProviders()) {
			if (p.getInternalType() === "MiningRigRentals") {
				let profiles = p.returnPoolProfiles()
				for (let i in profiles) {
					if (profiles[i].id === id) {
						let res;
						try {
							res = await p.deletePoolProfile(id)
						} catch (err) {
							throw new Error(err)
						}
						if (res.success) {
							p.poolProfiles.splice(i, 1)
						}
					}
				}
			}
		}
		return {success: true, message: 'profile deleted'}
	}

	/**
	 * Get Pool Profiles for all MRR Providers attached via the MRR API
	 * @async
	 * @return {Array.<Object>}
	 */
	async getPoolProfiles() {
		if (this.getRentalProviders().length === 0) {
			this._setPools = []
			return []
		}

		let profiles = []
		let profileIDs = []
		for (let provider of this.getRentalProviders()) {
			if (provider.getInternalType() === "MiningRigRentals") {
				let res = await provider.getPoolProfiles()
				let tmpProfiles = [];
				if (res.success) {
					tmpProfiles = res.data
				}
				for (let profile of tmpProfiles) {
					if (!profileIDs.includes(profile.id)) {
						profileIDs.push(profile.id)
						profiles.push(profile)
					}
				}
			}
		}

		this._setPoolProfiles(profiles)
		return profiles
	}

	/**
	 * Return the pool profiles stored locally for all MRR providers
	 * @return {Array.<Object>}
	 */
	returnPoolProfiles() {
		if (this.getRentalProviders().length === 0) {
			this._setPoolProfiles = []
			return []
		}

		let returnProfiles = []
		let profileIDs = []
		for (let provider of this.getRentalProviders()) {
			if (provider.getInternalType() === "MiningRigRentals") {
				let profiles = provider.returnPoolProfiles()
				for (let profile of profiles) {
					if (!profileIDs.includes(profile.id)) {
						profileIDs.push(profile.id)
						returnProfiles.push(profile)
					}
				}
			}
		}
		this._setPoolProfiles(returnProfiles)
		return returnProfiles
	}

	/**
	 * Set pool profiles to local variable
	 * @private
	 */
	_setPoolProfiles(profiles) {
		this.poolProfiles = profiles
	}

	/**
	 * Save a rental_info/history object to local storage
	 * @param {Object} receipt - an object containing information about a rental
	 */
	saveReceipt(receipt) {
		receipt.timestamp = moment().format("dddd, MMMM Do YYYY, h:mm:ss a")
		receipt.unixTimestamp = Date.now()
		receipt.id = uid()
		this.receipts.push(receipt)
		this.serialize()
	}

	/**
	 * Clear Receipts
	 */
	clearReceipts() {
		this.receipts = []
		this.serialize()
	}

	/**
	 * Remove Receipt(s)
	 */
	removeReceipts(ids) {
		if (!Array.isArray(ids)) {
			ids = [ids]
		}
		for (let id of ids) {
			for (let i = this.receipts.length - 1; i >= 0; i--) {
				if (this.receipts[i].id === id) {
					this.receipts.splice(i, 1)
				}
			}
		}

		let match = false
		for (let id of ids) {
			for (let i = this.receipts.length - 1; i >= 0; i--) {
				if (this.receipts[i].id === id) {
					match = true
				}
			}
		}
		if (!match) this.serialize()
		return {success: !match}
	}

	/**
	 * Get receipts
	 */
	returnReceipts() {
		return this.receipts
	}

	/**
	 * Serialize all information about SpartanBot to LocalStorage (save the current state)
	 * @return {Boolean} Returns true if successful
	 * @private
	 */
	serialize(){
		let serialized = {
			rental_providers: [],
			rental_strategies: {}
		}

		serialized.settings = this.settings
		serialized.oip_account = this.oip_account
		serialized.pools = this.pools
		serialized.poolProfiles = this.poolProfiles
		serialized.receipts = this.receipts

		for (let provider of this.rental_providers)
			serialized.rental_providers.push(provider.serialize())

		for (let strategyType in this.rental_strategies)
			serialized.rental_strategies[strategyType] = this.rental_strategies[strategyType].serialize()

		if (!this.settings.memory)
			localStorage.setItem('spartanbot-storage', JSON.stringify(serialized))
	}

	/**
	 * Load all serialized (saved) data from LocalStorage
	 * @return {Boolean} Returns true on deserialize success
	 * @private
	 */
	async deserialize(){
		let data_from_storage = {}

		if (localStorage.getItem('spartanbot-storage'))
			data_from_storage = JSON.parse(localStorage.getItem('spartanbot-storage'))

		if (data_from_storage.settings)
			this.settings = {...data_from_storage.settings, ...this.settings}

		if (data_from_storage.oip_account){
			this.oip_account = data_from_storage.oip_account
		}

		if (data_from_storage.pools){
			this.pools = data_from_storage.pools
		}

		if (data_from_storage.poolProfiles){
			this.poolProfiles = data_from_storage.poolProfiles
		}

		if (data_from_storage.receipts){
			this.receipts = data_from_storage.receipts
		}

		if (data_from_storage.rental_providers){
			for (let provider of data_from_storage.rental_providers){
				await this.setupRentalProvider(provider)
			}
		}

		if (data_from_storage.rental_strategies){
			for (let strategyType in data_from_storage.rental_strategies){
				this.setupRentalStrategy(data_from_storage.rental_strategies[strategyType])
			}
		}

		return true
	}
}

//-------------------------------------------------------------


let settingsNiceHash = { //devons
    type: 'NiceHash',
    api_key: 'f6fd8b01-8709-4959-a43b-cf4f316912f6',
    api_secret: 
      '204f5b91-1788-44a1-a68c-78a507a4ac363004314a-3c13-48fc-822a-47746bb782d1',
    api_id: 'e9a8215b-b2e1-47e9-913d-3b6ee48f36fb',
    name: 'NiceHash'
};
let settingsMRR = {
    type: 'MiningRigRentals',
    api_key: 'YOURAPIKEYS',
    api_secret: 
      'YOURAPISECRET',
    name: 'MiningRigRentals'
};

let spartanBot = new SpartanBot()

// let workerAddress = 'RQ53R914eqTW1TUydNarJRXCqvzgxumzDN';
// let workerAddress = 'RPaaykQ21WyN5fSxcCgAFrEUznPAA8NkLm';
// let workerAddress = 'RDahgf8vP1eDxHSWa3FEaBBt2pYvhdtZ5D';
// let workerAddress = 'RRYb61YAxJB6HhSWNYr4QH3dxmpQvRr1vp';
// let workerAddress = 'RGystomrH55DYMJKZw4Hkp89vxV1DTTSuN'; 
// let workerAddress = 'RM9ncrtmq7aN1Qfnj5jeqdtffTSawTPRZo'; 

let workerAddress = 'RRj8fK1WRUr6mHWxwMF3Cb7X35HcmF9Pet'; //TrueDevs RVN worker

//let workerAddress = 'RHERYpAgGvKNCy5h2K6JWnuXDzZih88KZ3'; // KsaRedFXs RVN worker


let MinerSubStatusCodes = new Array();
  MinerSubStatusCodes[0] = `Not Currently Mining`;
  MinerSubStatusCodes[1] = `Currently Mining`;
  MinerSubStatusCodes[2] = `Not Currently Mining But Mined Recently`;
  MinerSubStatusCodes[3] = `Address May be Invalid, or Has Not Started Mining Yet`;
  MinerSubStatusCodes[4] = `Miner ${workerAddress} has never mined before`;
  MinerSubStatusCodes[9] = `Unknown, Pool is Offline`;
          

let CandidateBlocksSubStatusCodes = new Array();
  CandidateBlocksSubStatusCodes[0] = `Have Reached Maturity`;
  CandidateBlocksSubStatusCodes[1] = `Waiting To Reach Maturity`;
  CandidateBlocksSubStatusCodes[9] = `Unkown, Pool is Offline`;

let RoundSharesSubStatusCodes = new Array();
  RoundSharesSubStatusCodes[0] = `Do Not Exist at Pool`;
  RoundSharesSubStatusCodes[1] = `Do Exist at Pool`
  RoundSharesSubStatusCodes[9] = `Unknown, Pool is Offline`;

let RentalCompositeStatusCodes = new Array(); 
  RentalCompositeStatusCodes[0] = `No Active Orders`;
  RentalCompositeStatusCodes[1] = `Order Active`;
  RentalCompositeStatusCodes[2] = `Order Ending Soon`;
  RentalCompositeStatusCodes[3] = `Order Ended`;
  RentalCompositeStatusCodes[4] = `Order Is Dead, Increase Price`;
  RentalCompositeStatusCodes[5] = `Order Active but Not Live`;  
  RentalCompositeStatusCodes[6] = `Unhandled Status, investigate`;
  RentalCompositeStatusCodes[7] = `New Provider Account, No Previous Orders`
  RentalCompositeStatusCodes[8] = `Unknown, Pool is Offline`;
  RentalCompositeStatusCodes[9] = `Provider is Offline`;

let RewardsCompositeCodes = new Array();
  RewardsCompositeCodes[0] = `All Rewards Counted`;
  RewardsCompositeCodes[1] = `Rewards Pending Still`;
  RewardsCompositeCodes[9] = `Unknown, Pool is Offline`;

let BotStatusCodes = new Array();
  BotStatusCodes[0] = ``;
  BotStatusCodes[1] = `Currently Projected to Surpass Requested Profit Margin`;
  BotStatusCodes[2] = `Currently Projected to be Profitable`;
  BotStatusCodes[3] = `Currently Projected to be Unprofitable`;
  BotStatusCodes[4] = ``;
  BotStatusCodes[6] = `All Rewards Counted, Prepared for Next Rental`;

let SpartanBotCompositeStatusCodes = new Array();
  SpartanBotCompositeStatusCodes[0] = `No Active Orders`;
  SpartanBotCompositeStatusCodes[1] = `No Active Orders, Rent Now`;
  SpartanBotCompositeStatusCodes[2] = `No Active Orders, Rental May Be Recommended`;
  SpartanBotCompositeStatusCodes[3] = `No Active Orders, Not Recommended`;

  SpartanBotCompositeStatusCodes[101, 102, 103] = `Active Order, Currently Mining, All Rewards Counted`;
  SpartanBotCompositeStatusCodes[111, 112, 113] = `Active Order, Currently Mining, Rewards Pending Still`;

  SpartanBotCompositeStatusCodes[201, 202, 203] = `Order Ending Soon, All Rewards Counted`;
  SpartanBotCompositeStatusCodes[211, 212, 213] = `Order Ending Soon, Rewards Pending Still`;
  
  SpartanBotCompositeStatusCodes[301, 302, 303] = `Order Ended Recently, All Rewards Counted`;
  SpartanBotCompositeStatusCodes[311, 312, 313] = `Order Ended Recently, Rewards Pending Still`;
  
  SpartanBotCompositeStatusCodes[306] = `Order Ended Recently, All Rewards Counted`;

  SpartanBotCompositeStatusCodes[402] = `Dead Order, All Rewards Counted, Consider Ending Rental Early`;
  SpartanBotCompositeStatusCodes[403] = `Dead Order, All Rewards Counted, Recommend Waiting`;
  SpartanBotCompositeStatusCodes[411] = `Dead Order, Rewards Pending Still; Consider Increasing Price`;  
  
  SpartanBotCompositeStatusCodes[504] = `Order Active but Not Yet Live, No Rewards Earned Yet`;

  SpartanBotCompositeStatusCodes[701] = `New Rental Provider Account, No Rentals Made Yet, Rental Recommended Highly`;
  SpartanBotCompositeStatusCodes[702] = `New Rental Provider Account, No Rentals Made Yet, Rental Recommended`;
  SpartanBotCompositeStatusCodes[703] = `New Rental Provider Account, No Rentals Made Yet, Rental Not Recommended Now`;

  SpartanBotCompositeStatusCodes[899] = `Pool is Offline`;
  SpartanBotCompositeStatusCodes[908] = `Provider is Offline`;

let MinerSubStatusCode = 'm' //miner
let CandidateBlocksSubStatusCode = 'b' //blocks
let RoundSharesSubStatusCode = 's' //shares

let RentalCompositeStatusCode = 'p' //provider
let RewardsCompositeCode = 'r' //rewards

let BotStatusCode = 'b' //timer

let SpartanBotCompositeStatusCode = 'prb' // provider rewards bot

let rentalProvider = spartanBot
  .setupRentalProvider(settingsNiceHash)
  .then( async (provider) => {

    function userinput() {
        let token = 'RVN';
        let tokenAlgo = 'KAWPOW';
        let nextWorker = workerAddress
        let minDuration = .5;  // this should be a user setting (not in the main interface)
        let minMargin = .10
          return { token, tokenAlgo, nextWorker, minDuration, minMargin};
    }

    function output(CurrentConditions, Rental, token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode, RewardsCompositeCode){
      let SpartanBotCompositeStatusCodeIndex = (SpartanBotCompositeStatusCode === '000') ? (0) : ((SpartanBotCompositeStatusCode === '001')?(1):((SpartanBotCompositeStatusCode === '002')?(2):((SpartanBotCompositeStatusCode === '003')?(3):(SpartanBotCompositeStatusCode))));
      let SpartanBotStatus = SpartanBotCompositeStatusCodes[SpartanBotCompositeStatusCodeIndex]
      let estTimeRemainingInSec = (RentalCompositeStatusCode >= 7) ? (0) : ((RentalCompositeStatusCode === 3) ? (0) : ((Rental.RentalCompositeStatusCode === 0) ? (0) : ((Rental.RentalOrders.estimateDurationInSeconds === undefined)?(Rental.rentalDuration * 60 * 60):("Unknown")))) 
      let nextUpdateInSecs = sleeptime / 1000

      let rentalPercentCompleteLoop = 0;
      let boundarieslineloop = 0;
      let ArbPrcnt = (SpartanBotCompositeStatusCode > 100) ? ((LiveEstimatesFromMining === undefined )?(1):(1 + LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)) : ((BestArbitrageCurrentConditions === undefined)?(1):(1 + BestArbitrageCurrentConditions.ProjectedProfitMargin))
      let profitbarloop = 0;

      let chunks = 120
      let rentalcomplete = (RentalCompositeStatusCode >= 7) ? (1) : ((Rental.RentalCompositeStatusCode > 0) ? ((Rental.RentalOrders.status.code === 'CANCELLED')?(1):(Rental.rentalPercentComplete)) : (1) )
      let rentalPercentCompleteDisplay = ``;
      let horizontalline = ``;
      while (boundarieslineloop < chunks) {
        horizontalline = horizontalline.concat(`-`)
        boundarieslineloop += 1
      }
      rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(horizontalline)
      rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(`\n`)
      while (rentalPercentCompleteLoop < rentalcomplete - (1/chunks)) {
        rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(`|`)
        rentalPercentCompleteLoop += (1/chunks)
      }
      rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(`\n`)
      while (profitbarloop < ArbPrcnt){
       rentalPercentCompleteDisplay = (Rental.RentalCompositeStatusCode > 0) ? ((ArbPrcnt>1)?(rentalPercentCompleteDisplay.concat(`\x1b[32m]\x1b[0m`)):((ArbPrcnt>.9)?(rentalPercentCompleteDisplay.concat(`\x1b[33m]\x1b[0m`)):(rentalPercentCompleteDisplay.concat(`\x1b[31m]\x1b[0m`)))) : ((ArbPrcnt>1)?(rentalPercentCompleteDisplay.concat(`\x1b[2m\x1b[32m)\x1b[0m`)):((ArbPrcnt>.9)?(rentalPercentCompleteDisplay.concat(`\x1b[2m\x1b[33m)\x1b[0m`)):(rentalPercentCompleteDisplay.concat(`\x1b[2m\x1b[31m)\x1b[0m`))))
       profitbarloop += (1/chunks)  
      }
      rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(`\n`)
      rentalPercentCompleteLoop = 0
      while (rentalPercentCompleteLoop < rentalcomplete - (1/chunks)) {
        rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(`|`)
        rentalPercentCompleteLoop += (1/chunks)
      }
      rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(`\n`)
      boundarieslineloop = 0
      rentalPercentCompleteDisplay = rentalPercentCompleteDisplay.concat(horizontalline)
      

      var timestamp = new Date().getTime();
      var formatteddate = new Date(timestamp).toLocaleDateString("en-US")
      var formattedtime = new Date(timestamp).toLocaleTimeString("en-US")
      var rentalendtime = (RentalCompositeStatusCode >= 7)?(0):(Date.parse(Rental.RentalOrders.endTs))
      var formattedrentalendtime = new Date(rentalendtime).toLocaleTimeString("en-US")
      var timesincerentalended = 
      Math.floor(
        ((timestamp - rentalendtime)/(1000*60))
          *1)/1
      // console.log('SpartanBotCompositeStatusCode:', SpartanBotCompositeStatusCode)
      

      if(SpartanBotCompositeStatusCode === '001'){ //no orders; current arb op would be profitable and above requested min
        if (CurrentConditions.UsersBalance < 0.005){
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
          \x1b[5m\x1b[31mUser Balance in Provider Wallet too low for a rental \x1b[0m
          \x1b[32m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // ,`\n${horizontalline}`
          )
        } else {
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m\n
          ${BotStatusCodes[BotStatusCode]}\x1b[0m\n\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // `\n${horizontalline}`
          )
        } 
      } else if(SpartanBotCompositeStatusCode === '002'){ //no orders; current arb op would be profitable but less than requested min
        if (CurrentConditions.UsersBalance < 0.005){
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
          \x1b[5m\x1b[31mUser Balance in Provider Wallet too low for a rental \x1b[0m
          \x1b[32m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // `\n${horizontalline}`
          )
        } else {
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}
          ${BotStatusCodes[BotStatusCode]}\x1b[0m\n\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // `\n${horizontalline}`
          )
        }
      } else if(SpartanBotCompositeStatusCode === '003'){ //no orders; current arb op would be unprofitable
        if (CurrentConditions.UsersBalance < 0.005){
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
          \x1b[5m\x1b[31mUser Balance in Provider Wallet too low for a rental \x1b[0m
          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}
          ${BotStatusCodes[BotStatusCode]}\x1b[0m\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`,
          // `\n${horizontalline}`
          )
        } else {
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}

          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m
          \x1b[31m\x1b[1m${BotStatusCodes[BotStatusCode]}\x1b[0m\n\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`,
          // `\n${horizontalline}`
          )
        }                   
      } else if(SpartanBotCompositeStatusCode === '102'){ //active order; rewards counted; looking profitable
        if (LiveEstimatesFromMining === undefined) { // too early, no estimates yet
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m

          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${horizontalline}\n\n\n\n${horizontalline}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$ ? (GPM: ? %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m ? \x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m ? \x1b[0m BTC (\x1b[4m$ ? \x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((Rental.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m\n${horizontalline}`)
        } else { //estimates are available
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m

          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${horizontalline}\n\n\n\n${horizontalline}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m

          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m\n${horizontalline}`)
        }
      } else if(SpartanBotCompositeStatusCode === '103'){ //active order; rewards counted; looking unprofitable so far
        if (LiveEstimatesFromMining === undefined) { // too early, no estimates yet
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m

          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${horizontalline}\n\n\n\n${horizontalline}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$ ? (GPM: ? %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m ? \x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m ? \x1b[0m BTC (\x1b[4m$ ? \x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((Rental.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m\n${horizontalline}`)
        } else { //estimates are available
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m

          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
        
          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m\n${horizontalline}`)
        } 
      } else if(SpartanBotCompositeStatusCode === '111'){ //active order; rewards pending; looking profitable
          console.log(
          `${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m
          
          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
         
          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus}\x1b[0m
          
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.
          
          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '112'){ //active order; rewards pending; looking profitable
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m
          
          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
         
          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
          
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.
         
          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '113'){ //active order; rewards pending; looking unprofitable so far
        if (LiveEstimatesFromMining === undefined) { // too early, no estimates yet
          console.log(`${horizontalline}
          \x1b[33mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[CurrentConditions.MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[CurrentConditions.RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CurrentConditions.CandidateBlocksSubStatusCode]}

          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[CurrentRental.RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m

          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$ ? (GPM: ? %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m ? \x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m ? \x1b[0m BTC (\x1b[4m$ ? \x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((Rental.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
        } else { //estimates are available
          console.log(`${horizontalline}
          \x1b[33mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[CurrentConditions.MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[CurrentConditions.RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CurrentConditions.CandidateBlocksSubStatusCode]}

          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[CurrentRental.RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m

          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
        }
      } else if(SpartanBotCompositeStatusCode === '202'){ //active order ending soon, rewards counted, looking unprofitable
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m
          
          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
         
          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
          
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.
         
          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '203'){
          console.log(`${horizontalline}
          \x1b[33mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[CurrentConditions.MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[CurrentConditions.RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CurrentConditions.CandidateBlocksSubStatusCode]}

          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[CurrentRental.RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m

          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '211'){
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m
          
          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CurrentConditions.CandidateBlocksSubStatusCode]}
          ${CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
         
          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
          
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.
         
          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m
          
          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '212'){
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m
          
          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
         
          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
          
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.
         
          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '213'){
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m
          
          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
         
          \x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
          
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.
         
          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          Est Time Remaining In Rental: ${Rental.estTimeRemainingInRoundHours}:${Rental.estTimeRemainingInRoundMins}:${Rental.estTimeRemainingRSecs} \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '301'){
          console.log( //ended, bold green status, bold green profit
          `${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[32m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago`)
      } else if(SpartanBotCompositeStatusCode === '302'){
          console.log( //ended, green status, green profit
          `${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[32m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago`)     
      } else if(SpartanBotCompositeStatusCode === '303'){
          console.log( //ended, bold red status, bold red profit
          `${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[CurrentConditions.MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[CurrentConditions.RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CurrentConditions.CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[CurrentRental.RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[31m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% ${Rental.RentalStatus}\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago`)    
      } else if(SpartanBotCompositeStatusCode === '306'){
        if (BotStatus.currentlyProfitable){
          console.log( //ended, bold green status, bold green profit
          `${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[CurrentRental.RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
         
          \x1b[32m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[32m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.
          
          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago`)
        } else{
          console.log( //ended, bold red status, bold red profit
          `${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[31m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago`)
          }
      } else if(SpartanBotCompositeStatusCode === '311'){
          console.log( //ended, bold green status, bold green profit
          `${horizontalline}  
          \x1b[32m\x1b[1mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[32m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago` 
          )
      } else if(SpartanBotCompositeStatusCode === '312'){
          console.log( //ended, green status, green profit
          `${horizontalline}  
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[32m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}
          
          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[32m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago` 
          )
      } else if(SpartanBotCompositeStatusCode === '313'){
          console.log( //ended, bold red status, bold red profit
          `${horizontalline}  
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[31m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% ${Rental.RentalOrders.status.code}\n${rentalPercentCompleteDisplay}

          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago` 
          )
      } else if(SpartanBotCompositeStatusCode === '403'){
          console.log( //ended, bold red status, bold red profit
          `${horizontalline}  
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[31m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}

          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago` 
          )
      } else if(SpartanBotCompositeStatusCode === '402'){
          console.log( //ended, bold red status, bold red profit
          `${horizontalline}  
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[31m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}

          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago` 
          )
      } else if(SpartanBotCompositeStatusCode === '411'){
          console.log( //ended, bold red status, bold red profit
          `${horizontalline}  
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[31m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}

          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago` 
          )
      } else if(SpartanBotCompositeStatusCode === '504'){
          console.log( //ended, bold red status, bold red profit
          `${horizontalline}  
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : Miner: ${UserInput.nextWorker} is ${MinerSubStatusCodes[CurrentConditions.MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[CurrentConditions.RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CurrentConditions.CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental ${RentalCompositeStatusCodes[CurrentRental.RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode}\x1b[0m : \x1b[31m\x1b[1m${SpartanBotStatus} ${BotStatusCodes[BotStatusCode]}\x1b[0m
         
          Rental ID: ${Rental.rentalOrderIdReadable} ${Math.round((Rental.rentalPercentComplete)*1e3)/1e1}% Complete\n${rentalPercentCompleteDisplay}

          Estimated Arbitrage Opportunity For Current Rental:
          Est profit of: \x1b[31m\x1b[1m$${LiveEstimatesFromMining.ProfitUsd} (GPM: ${Math.round((LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt)*1e4)/1e2} %)\x1b[0m, 
          Rented \x1b[4m${Rental.RentalOrders.limit}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m
          For \x1b[4m${Rental.rentalDuration}\x1b[0m hours at \x1b[4m${Rental.RentalOrders.price}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${LiveEstimatesFromMining.LiveEstimateQtyOfTokensToBeMined}\x1b[0m \x1b[4m${token}\x1b[0m (${LiveEstimatesFromMining.minedTokens} so far)
          Cost of Rental: \x1b[4m${Rental.RentalOrders.amount}\x1b[0m BTC (\x1b[4m$${Rental.CostOfRentalInUsd}\x1b[0m)
          Estimated Rev:  \x1b[4m${LiveEstimatesFromMining.ValueOfEstTokensAtMarketPrice}\x1b[0m BTC (\x1b[4m$${LiveEstimatesFromMining.ValueOfEstTokensAtMktPriceUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((LiveEstimatesFromMining.actualNetworkPercent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${CurrentConditions.poolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m Rental Ended ${timesincerentalended} minutes ago` 
          )
      } else if(SpartanBotCompositeStatusCode === '701'){ //no orders; current arb op would be profitable and above requested min
        if (CurrentConditions.UsersBalance < 0.005){
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
          \x1b[5m\x1b[31mUser Balance in Provider Wallet too low for a rental \x1b[0m
          \x1b[32m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // ,`\n${horizontalline}`
          )
        } else {
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m\n
          ${BotStatusCodes[BotStatusCode]}\x1b[0m\n\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // `\n${horizontalline}`
          )
        } 
      } else if(SpartanBotCompositeStatusCode === '702'){ //no orders; current arb op would be profitable but less than requested min
        if (CurrentConditions.UsersBalance < 0.005){
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
          \x1b[5m\x1b[31mUser Balance in Provider Wallet too low for a rental \x1b[0m
          \x1b[32m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // `\n${horizontalline}`
          )
        } else {
          console.log(`${horizontalline}
          \x1b[32mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${CurrentRental.RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[32m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}
          ${BotStatusCodes[BotStatusCode]}\x1b[0m\n\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[32m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`
          // `\n${horizontalline}`
          )
        }
      } else if(SpartanBotCompositeStatusCode === '703'){ //no orders; current arb op would be unprofitable
        if (CurrentConditions.UsersBalance < 0.005){
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}
         
          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}
          \x1b[5m\x1b[31mUser Balance in Provider Wallet too low for a rental \x1b[0m
          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}
          ${BotStatusCodes[BotStatusCode]}\x1b[0m\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`,
          // `\n${horizontalline}`
          )
        } else {
          console.log(`${horizontalline}
          \x1b[31mSpartanBot Status at ${formattedtime} on ${formatteddate} (${timestamp}):\x1b[0m

          ${CurrentConditions.MinerSubStatusCode} : ${MinerSubStatusCodes[MinerSubStatusCode]}
          ${CurrentConditions.RoundSharesSubStatusCode} : Round Shares ${RoundSharesSubStatusCodes[RoundSharesSubStatusCode]}
          ${CurrentConditions.CandidateBlocksSubStatusCode} : Candidate Blocks: ${CandidateBlocksSubStatusCodes[CandidateBlocksSubStatusCode]}

          ${RentalCompositeStatusCode} : Rental Provider has ${RentalCompositeStatusCodes[RentalCompositeStatusCode]}
          ${CurrentConditions.RewardsCompositeCode} : ${RewardsCompositeCodes[CurrentConditions.RewardsCompositeCode]}
          ${BotStatusCode} : ${BotStatusCodes[BotStatusCode]}

          \x1b[31m\x1b[1m${SpartanBotCompositeStatusCode} : ${SpartanBotStatus}\x1b[0m
          \x1b[31m\x1b[1m${BotStatusCodes[BotStatusCode]}\x1b[0m\n\n${rentalPercentCompleteDisplay}

          Best Arbitrage Opportunity For Current Conditions:
          Est profit of: \x1b[31m\x1b[1m$${BestArbitrageCurrentConditions.ProjectedProfitInUsd} (GPM: ${Math.round((BestArbitrageCurrentConditions.ProjectedProfitMargin)*1e4)/1e2} %)\x1b[0m, 
          Rent \x1b[4m${BestArbitrageCurrentConditions.HashrateToRent}\x1b[0m \x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m from the \x1b[4m${CurrentConditions.marketpreferenceKawpow}\x1b[0m Market
          For \x1b[4m${BestArbitrageCurrentConditions.RentalDuration}\x1b[0m hours at \x1b[4m${BestArbitrageCurrentConditions.RentalHashPrice}\x1b[0m BTC/\x1b[4m${CurrentConditions.MarketFactorName}\x1b[0m/Day.

          Estimated Rewards: \x1b[4m${BestArbitrageCurrentConditions.ProjectedTokenRewards}\x1b[0m \x1b[4m${token}\x1b[0m
          Cost of Rental: \x1b[4m${BestArbitrageCurrentConditions.CostOfRentalInBtc}\x1b[0m BTC (\x1b[4m$${Math.round((BestArbitrageCurrentConditions.CostOfRentalInUsd)*1e2)/1e2}\x1b[0m)
          Estimated Rev:  \x1b[4m${BestArbitrageCurrentConditions.ProjectedRevenueInBtc}\x1b[0m BTC (\x1b[4m$${BestArbitrageCurrentConditions.ProjectedRevenueInUsd}\x1b[0m) 
          NetworkPercent: \x1b[4m${Math.round((BestArbitrageCurrentConditions.NetworkPercentToRent)*1e4)/1e2}\x1b[0m %
          Est PoolWeight: \x1b[4m${BestArbitrageCurrentConditions.ExpectedPoolDominanceMultiplier}\x1b[0m
          Pool is Currently: \x1b[4m${CurrentConditions.currentlyLuckyWords} (${CurrentConditions.luck64rounded})\x1b[0m
          and Trending: \x1b[4m${CurrentConditions.luckTrend}\x1b[0m

          \x1b[5mNext Update In: ${nextUpdateInSecs} seconds \x1b[0m`,
          // `\n${horizontalline}`
          )
        }
      } else if(SpartanBotCompositeStatusCode === '899'){
        console.log(
          `
          SpartanBot Status at ${timestamp}:
          \x1b[36m\x1b[1m${SpartanBotStatus} (${Rental.SpartanBotCompositeStatusCode})\x1b[0m`)
      } else if(SpartanBotCompositeStatusCode === '908'){
        console.log(
          `
          SpartanBot Status at ${timestamp}:
          \x1b[36m\x1b[1m${SpartanBotStatus} (${SpartanBotCompositeStatusCode})\x1b[0m`)
      }
    }

    async function getcurrentconditions(token, tokenAlgo, minDuration, tokensPerBlock, blocksPerHour) {
      try{
        let UsersBalance = await provider.provider.getBalance();
        // let UsersBalance = 10;
        let summariesKawpowUSA = await provider.provider.getStandardPrice('KAWPOW','USA')
        let summariesKawpowEU = await provider.provider.getStandardPrice('KAWPOW','EU')
        let summariesScryptUSA = await provider.provider.getStandardPrice('SCRYPT','USA')
        let summariesScryptEU = await provider.provider.getStandardPrice('SCRYPT','EU')
        let orderBookKawpow = await provider.provider.getOrderBook('kawpow')
        let totalSpeedKawpowUSA = orderBookKawpow.stats.USA.totalSpeed;
        let totalSpeedKawpowEU = orderBookKawpow.stats.EU.totalSpeed;
        let orderBookScrypt = await provider.provider.getOrderBook('scrypt')
        let totalSpeedScryptUSA = orderBookScrypt.stats.USA.totalSpeed;
        let totalSpeedScryptEU = orderBookScrypt.stats.EU.totalSpeed;
        let PriceRentalStandardKawpowUSA = Math.round(( (10 * summariesKawpowUSA.summaries['USA,KAWPOW'].payingPrice) + 0.0002 )*1e4)/1e4
        let PriceRentalStandardKawpowEU = Math.round(( (10 * summariesKawpowEU.summaries['EU,KAWPOW'].payingPrice) + 0.0002 )*1e4)/1e4
        let PriceRentalStandardScryptUSA = Math.round(( 10000 * summariesScryptUSA.summaries['USA,SCRYPT'].payingPrice )*1e4)/1e4
        let PriceRentalStandardScryptEU = Math.round(( 10000 * summariesScryptEU.summaries['EU,SCRYPT'].payingPrice )*1e4)/1e4
        let marketpreferenceKawpow = (PriceRentalStandardKawpowUSA <= PriceRentalStandardKawpowEU) ? ((totalSpeedKawpowUSA >= (totalSpeedKawpowEU/2))?('USA'):('EU')) : ('EU')
        let marketpreferenceScrypt = (PriceRentalStandardScryptUSA <= PriceRentalStandardScryptEU) ? ((totalSpeedScryptUSA >= (totalSpeedScryptEU/2))?('USA'):('EU')) : ('EU')
        let PriceRentalStandardKawpow = (marketpreferenceKawpow = 'EU') ? (PriceRentalStandardKawpowEU) : ((marketpreferenceKawpow = 'USA')?(PriceRentalStandardKawpowUSA):('error'))
        let PriceRentalStandardScrypt = (marketpreferenceScrypt = 'EU') ? (PriceRentalStandardScryptEU) : ((marketpreferenceScrypt = 'USA')?(PriceRentalStandardScryptUSA):('error'))
        let PriceRentalStandard = (tokenAlgo === 'KAWPOW') ? (PriceRentalStandardKawpow) : (tokenAlgo === 'SCRYPT') ? (PriceRentalStandardScrypt) : (null);
        let marketFactorKawpow = orderBookKawpow.stats.USA.marketFactor
        let marketFactorNameKawpow = orderBookKawpow.stats.USA.displayMarketFactor
        let marketFactorScrypt = orderBookScrypt.stats.USA.marketFactor
        let marketFactorNameScrypt = orderBookScrypt.stats.USA.displayMarketFactor
        let marketFactor = (tokenAlgo === 'KAWPOW') ? (marketFactorKawpow) : (tokenAlgo === 'SCRYPT') ? (marketFactorScrypt) : (null);
        let MarketFactorName = (tokenAlgo === 'KAWPOW') ? (marketFactorNameKawpow) : (tokenAlgo === 'SCRYPT') ? (marketFactorNameScrypt) : (null);
      
        async function rvnexplorerstats() {
          let apiURL ="https://main.rvn.explorer.oip.io/api/statistics/pools";
          return await new Promise ((resolve, reject) => {
            https.get(apiURL, (response) => {
              let body = ''
              response.on('data', (chunk) => {
                body += chunk;
              });
              response.on('end', () => {
                try { 
                  let data = JSON.parse(body);
                  let dat1 = data.blocks_by_pool;
                  if (dat1 === undefined) { 
                    let leadingMinerShare = 0;
                    let myPoolShare = 0;
                    let poolDominanceMultiplier = 1;
                    let secondPlaceMinerShare = 0;
                    resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare});
                  } else { 
                    let blocksminedtoday = data.n_blocks_mined
                    let current = data.pagination.current;
                    let prev = data.pagination.prev;
                    if (blocksminedtoday > 60) { //if lots of blocks   
                      for (let i = 0; i < dat1.length; i++) {
                        if (dat1[i].poolName === "2Miners PPLNS") {
                          let totals = dat1.slice(0, i + 1);
                          let leadingMinerShare = parseFloat(dat1[0].percent_total);
                          let secondPlaceMinerShare = parseFloat(dat1[1].percent_total);
                          let myPoolShare = parseFloat(totals.slice(-1)[0].percent_total);
                          if (myPoolShare = leadingMinerShare){
                            let poolDominanceMultiplier = Math.round(((Math.pow((myPoolShare/secondPlaceMinerShare),1.01)+4)/5)*1e2)/1e2
                            resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare, blocksminedtoday, prev});
                          } else {
                            let poolDominanceMultiplier = Math.pow((myPoolShare / leadingMinerShare),.18)
                            resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare, blocksminedtoday, prev});
                          }
                        }
                      }
                    } else { // not enough blocks
                      let leadingMinerShare = null
                      let myPoolShare = null
                      let poolDominanceMultiplier = null
                      let secondPlaceMinerShare = null
                    resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare, blocksminedtoday, prev});
                    } // not enough blocks
                  } // end of else (can read data)
                } catch(error){ //couldnt parse body into json
                  console.log("RVN Explorer Error, Explorer Offline", error)
                  let leadingMinerShare = 0.5;
                  let myPoolShare = 0.5;
                  let poolDominanceMultiplier = 1;
                  let secondPlaceMinerShare = 0.5;
                  resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare});
                } // end of catch
              }) // end of response on end
            }).on("error", (error) => {
              console.log("Error: " + error.message);
              reject("Error: " + error.message)
            })
          }) //if pool luck can work more effectively, this funtion can be removed entirely // this could be redundant if pool luck was used instead
        }

        async function rvnexplorerstatsprev(prev) {
          let apiURLbaseprev = "https://main.rvn.explorer.oip.io/api/statistics/pools?date="
          let apiURLprev = apiURLbaseprev.concat(prev)
          return await new Promise ((resolve, reject) => {
            https.get(apiURLprev, (response) => {
              let body = ''
              response.on('data', (chunk) => {
                body += chunk;
              });
              response.on('end', () => {
                try { // try to parse the body into json
                  let data = JSON.parse(body);
                  let dat1 = data.blocks_by_pool;
                  if (dat1 === undefined) { //cant read anything
                    let leadingMinerShare = 0;
                    let myPoolShare = 0;
                    let poolDominanceMultiplier = 1;
                    let secondPlaceMinerShare = 0;
                    resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare});
                  } else { //can read the data (does this matter?)
                    let blocksminedtoday = data.n_blocks_mined
                      for (let i = 0; i < dat1.length; i++) {
                        if (dat1[i].poolName === "2Miners PPLNS") {
                           
                          let totals = dat1.slice(0, i + 1);
                          let leadingMinerShare = parseFloat(dat1[0].percent_total);
                          let secondPlaceMinerShare = parseFloat(dat1[1].percent_total);
                          let myPoolShare = parseFloat(totals.slice(-1)[0].percent_total);
                          if (myPoolShare = leadingMinerShare){ 
                            let poolDominanceMultiplier = Math.round(((Math.pow((myPoolShare/secondPlaceMinerShare),1.01)+4)/5)*1e2)/1e2
                            resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare});
                          } else {
                            let poolDominanceMultiplier = Math.pow((myPoolShare / leadingMinerShare),.18)
                            resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare});
                          }
                        }
                      }
                  } // end of else (can read data)
                } catch(error){ //couldnt parse body into json
                  console.log("RVN Explorer Error, Explorer Offline", error)
                  let leadingMinerShare = 0.5;
                  let myPoolShare = 0.5;
                  let poolDominanceMultiplier = 1;
                  let secondPlaceMinerShare = 0.5;
                  resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare});
                } // end of catch
              }) // end of response on end
            }).on("error", (error) => {
              console.log("Error: " + error.message);
              reject("Error: " + error.message)
            })
          }) //if pool luck can work more effectively, this funtion can be removed entirely // this could be redundant if pool luck was used instead
        }

        async function floexplorerstats() {
          let apiURL =
            "https://livenet.flocha.in/api/blocks?limit=90";
          return await new Promise ((resolve, reject) => {
            https.get(apiURL, (response) => {
              let body = ''
              response.on('data', (chunk) => {
                body += chunk;
              });
              response.on('end', () => {
                try{
                  let data = JSON.parse(body);
                  let leadingMinerShare = 0;
                  let myPoolShare = 0;
                  let poolDominanceMultiplier = 1;
                  let secondPlaceMinerShare = 0;
                  resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare});
                } catch(error){
                  console.log("Flo Explorer Error", error)
                  let leadingMinerShare = 0;
                  let myPoolShare = 0;
                  let poolDominanceMultiplier = 1;
                  let secondPlaceMinerShare = 0;
                  resolve ({leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare})
                }
              })
            }).on("error", (error) => {
              console.log("Flo Explorer Error: " + error.message);
              reject("Error: " + error.message)
            })
          }) //if pool luck can work more effectively, this funtion can be removed entirely // this could be redundant if pool luck was used instead
        }
        let StatsFromExplorer = await rvnexplorerstats();
        let leadingMinerShareCurrent = StatsFromExplorer.leadingMinerShare;
        let myPoolShareCurrent = StatsFromExplorer.myPoolShare;
        let poolDominanceMultiplierCurrent = StatsFromExplorer.poolDominanceMultiplier;
        let secondPlaceMinerShareCurrent = StatsFromExplorer.secondPlaceMinerShare;
        let blocksminedtoday = StatsFromExplorer.blocksminedtoday;
        let StatsFromExplorerPrev = await rvnexplorerstatsprev(StatsFromExplorer.prev);
        let leadingMinerSharePrev = StatsFromExplorerPrev.leadingMinerShare
        let myPoolSharePrev = StatsFromExplorerPrev.myPoolShare
        let poolDominanceMultiplierPrev = StatsFromExplorerPrev.poolDominanceMultiplier
        let secondPlaceMinerSharePrev = StatsFromExplorerPrev.secondPlaceMinerShare
        let immatureDay = (blocksminedtoday < 60)
        let leadingMinerShare = (immatureDay) ? (leadingMinerSharePrev) : (leadingMinerShareCurrent);
        let myPoolShare = (immatureDay) ? (myPoolSharePrev) : (myPoolShareCurrent);
        let poolDominanceMultiplier = (immatureDay) ? (poolDominanceMultiplierPrev) : (poolDominanceMultiplierCurrent)
        let secondPlaceMinerShare = (immatureDay) ? (secondPlaceMinerSharePrev) : (secondPlaceMinerShareCurrent)

        async function datafrompoolrvn2miners(nextWorker, marketFactor) {
          async function rvn2minersstats( props ) {
            return await new Promise((resolve, reject) => {
              let URL = "https://rvn.2miners.com/api/stats";
              https
                .get(URL, (response, reject) => {
                  {
                    //work has been received
                    let body = "";
                    response.on("data", (chunk) => {
                      body += chunk;
                    });
                    response.on("end", () => {
                      let data = JSON.parse(body);
                      let networkhashps = data.nodes[0].networkhashps;
                      let Networkhashrate = Math.round((networkhashps / marketFactor)*1e3)/1e3;
                      let Poolhashrate = Math.round((data.hashrate / marketFactor)*1e3)/1e3;
                      let blockheight = data.nodes[0].height
                      let avgBlockTime = data.nodes[0].avgBlockTime
                      let poolluck = data.luck
                        resolve({networkhashps, Networkhashrate, Poolhashrate, blockheight, avgBlockTime, poolluck});
                    });
                  }
                })
                .on("error", (error) => {
                  console.log("Error rvn2minersstats: " + error.message);
                  reject("Error: " + error.message);
                });
            });
          }

          async function rvn2minersblocks (){
            let apiURL =
              "https://rvn.2miners.com/api/blocks";
            return await new Promise ((resolve, reject) => {
              https.get(apiURL, (response) => {
                let body = ''
                response.on('data', (chunk) => {
                  body += chunk;
                });
                response.on('end', () => {
                  try {
                    let data = JSON.parse(body); // can we parse the body (is there anything)?
                    let candidates = data.candidatesTotal
                    let immature = data.imatureTotal
                    let luck1024 = data.luck['1024'].luck
                    let luck256 = data.luck['256'].luck
                    let luck128 = data.luck['128'].luck
                    let luck64 = data.luck['64'].luck 
                    let luckhistory = data.luck
                    let bestLuck = Math.min(luck64, luck128, luck256, luck1024)
                    let currentlyLucky = (luck64 < 1) ? (true) : (false)
                    let luckTrend = (bestLuck === luck64) ? ('up recently') : (bestLuck === luck1024) ? ('down overall') : (bestLuck === luck128) ? ('up in past two hours but down in recent hour') : (bestLuck === luck256) ? ('down in past four hours') : ('i dont know')
                    if (candidates > 0) {
                      let CandidateBlocksSubStatusCode = 1
                      let lastcandidate = candidates - 1
                      let candidateheight = data.candidates[lastcandidate].height
                      resolve({candidates, candidateheight, CandidateBlocksSubStatusCode, luck1024, luck256, luck128, luck64, bestLuck, currentlyLucky, luckTrend})  
                    } else if (candidates === 0){
                      let CandidateBlocksSubStatusCode = 0
                      let candidateheight = null
                      resolve({candidates, candidateheight, CandidateBlocksSubStatusCode, luck1024, luck256, luck128, luck64, bestLuck, currentlyLucky, luckTrend})
                    }
                  }
                  catch (error) {
                    console.log('rvn2minersblocks',error)
                  }
                })
              }).on("error", (error) => {
                let CandidateBlocksSubStatusCode = 9
                console.log("Error: " + error.message);
                reject("Error: " + error.message, CandidateBlocksSubStatusCode)
              })
            })
          }

          async function rvn2minersaccounts( props ) { // sets miner status code
            // console.log('running rvn2minersaccounts')
            return await new Promise((resolve, reject) => {
              let endpointbase = "https://rvn.2miners.com/api/accounts/";
              let URL = endpointbase.concat(nextWorker);
              https
                .get(URL, (response, reject) => {
                  {
                    let body = "";
                    response.on("data", (chunk) => {
                      body += chunk;
                    });
                    response.on("end", () => {     
                      try {
                        let data = JSON.parse(body) //can body be parsed into JSON?
                        // console.log('body can be parsed')
                        let roundShares = data.roundShares
                        try { //can hashrate be read?
                          let currentHashrate = data.currentHashrate;
                          let currentHashrateReadable = currentHashrate / marketFactor;
                          let workersOnline = (data.workersOnline === undefined) ? 0 : (data.workersOnline)
                          var rewardsImmature = (data.stats.immature === undefined) ? 0 : (data.stats.immature / 1e8)
                          var rewardsBalance = (data.stats.balance === undefined) ? 0 : (data.stats.balance / 1e8)
                          var rewardsPaid = (data.stats.paid === undefined) ? 0 : (data.stats.paid / 1e8)
                          let rewardsCheck = rewardsImmature + rewardsBalance + rewardsPaid                    
                          let rewardsTotal = (rewardsCheck > 0) ? (rewardsImmature + rewardsBalance + rewardsPaid) : (0)
                          let earnedRewardsCheck = Math.round((rewardsTotal - rewardsBeforeRental)*1e8)/1e8
                          let earnedRewards = (earnedRewardsCheck > 0) ? (earnedRewardsCheck) : (0)
                          let rewardsStillPending = (data.rewards == null) ? (0) : (data.rewards[0].immature)
                          let lastShare = data.stats.lastShare * 1000
                          let timestamp = new Date().getTime();
                          let timeSinceLastShare = timestamp - lastShare
                          let recentlyMinedThreshold = 15 * 60 * 1000 // 15 minutes
                          let currentlyMiningThreshold = 2 * 60 * 1000 // 2 minutes
                          let averageHashrate = data.hashrate;
                          let MinerSubStatusCode = (timeSinceLastShare > recentlyMinedThreshold) ? (0) : ((timeSinceLastShare < currentlyMiningThreshold)?(1):(2)) 

                          resolve({  workersOnline, currentHashrate, currentHashrateReadable, rewardsBeforeRental, rewardsTotal, earnedRewards, rewardsStillPending, roundShares, rewardsImmature, rewardsBalance, rewardsPaid, MinerSubStatusCode, timeSinceLastShare})
                        }catch (error) { // if no, hashrate cannot be read
                          console.log('hashrate cannot be read')
                          let MinerSubStatusCode = 3
                          console.log('error', error, MinerSubStatusCodes[MinerSubStatusCode], `(Miner Status Code: ${MinerSubStatusCode})`)
                          let currentHashrate = 0
                          let currentHashrateReadable = 0
                          let workersOnline = 0
                          resolve({ workersOnline, currentHashrate, currentHashrateReadable, marketFactorName, rewardsBeforeRental, rewardsTotal, earnedRewards, rewardsStillPending, roundShares, MinerSubStatusCode})
                        }
                      }catch (error) { //if no, body cannot be parsed, new worker
                        let MinerSubStatusCode = 4
                        let currentHashrate = 0
                        let currentHashrateReadable = 0
                        let rewardsCheck = rewardsImmature + rewardsBalance + rewardsPaid                    
                        let rewardsTotal = (rewardsCheck > 0) ? (rewardsImmature + rewardsBalance + rewardsPaid) : (0)
                        let earnedRewardsCheck = Math.round((rewardsTotal - rewardsBeforeRental)*1e8)/1e8
                        let earnedRewards = (earnedRewardsCheck > 0) ? (earnedRewardsCheck) : (0)
                        let rewardsStillPending = null
                        let roundShares = 0
                        let workersOnline = 0
                        resolve({  workersOnline, currentHashrate, currentHashrateReadable, rewardsBeforeRental, rewardsTotal, earnedRewards, rewardsStillPending, roundShares, MinerSubStatusCode}) 
                      }
                    });
                  }
                }).on("error", (error) => {
                  let MinerSubStatusCode = 9
                  console.log("Error: " + error.message);
                  reject("Error: " + error.message);
                });
            });
          }

          let Rvn2MinersStats = await rvn2minersstats(marketFactor);
          let networkhashps = Rvn2MinersStats.networkhashps;
          let Networkhashrate = Rvn2MinersStats.Networkhashrate;
          let blockheight = Rvn2MinersStats.blockheight;
          let poolluck = Rvn2MinersStats.poolluck;
          let avgBlockTime = Rvn2MinersStats.avgBlockTime;

          let Rvn2minersBlocks = await rvn2minersblocks();
          let candidates = Rvn2minersBlocks.candidates
          let candidateheight = Rvn2minersBlocks.candidateheight
          let CandidateBlocksSubStatusCode = Rvn2minersBlocks.CandidateBlocksSubStatusCode
          let luck1024 = Rvn2minersBlocks.luck1024;
          let luck256 = Rvn2minersBlocks.luck256;
          let luck128 = Rvn2minersBlocks.luck128;
          let luck64 = Rvn2minersBlocks.luck64;
          let bestLuck = Rvn2minersBlocks.bestLuck;
          let currentlyLucky = Rvn2minersBlocks.currentlyLucky;
          let luckTrend = Rvn2minersBlocks.luckTrend;

          let Rvn2MinersAccounts = await rvn2minersaccounts(nextWorker, marketFactor, rewardsBeforeRental);
          let workersOnline = Rvn2MinersAccounts.workersOnline
          let currentHashrate = Rvn2MinersAccounts.currentHashrate
          let currentHashrateReadable = Rvn2MinersAccounts.currentHashrateReadable
          let rewardsTotal = Rvn2MinersAccounts.rewardsTotal
          let rewardsStillPending = Rvn2MinersAccounts.rewardsStillPending
          let earnedRewards = Rvn2MinersAccounts.earnedRewards
          let roundShares = Rvn2MinersAccounts.roundShares
          let rewardsImmature = Rvn2MinersAccounts.rewardsImmature
          let rewardsBalance = Rvn2MinersAccounts.rewardsBalance
          let rewardsPaid = Rvn2MinersAccounts.rewardsPaid
          let MinerSubStatusCode = Rvn2MinersAccounts.MinerSubStatusCode

          let RoundSharesSubStatusCode = (roundShares === 0) ? (0) : (1)
          // console.log('MinerSubStatusCode:', MinerSubStatusCode, MinerSubStatusCodes[MinerSubStatusCode])
          let RewardsCompositeCode = (MinerSubStatusCode === 1) ? (Math.max(RoundSharesSubStatusCode,CandidateBlocksSubStatusCode, workersOnline)) : ((MinerSubStatusCode === 2)?(1):((MinerSubStatusCode === 0)?(0):((MinerSubStatusCode === 4)?(0):('error1234'))))
          return {  workersOnline, currentHashrate, currentHashrateReadable, rewardsBeforeRental, rewardsTotal, earnedRewards, rewardsStillPending, roundShares, networkhashps, Networkhashrate, blockheight, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, RewardsCompositeCode, candidateheight, poolluck, avgBlockTime, luck1024, luck256, luck128, luck64, bestLuck, currentlyLucky, luckTrend};
        }

        let rewardsBeforeRental;
        let DataFromPool = await datafrompoolrvn2miners(UserInput.nextWorker, marketFactor, rewardsBeforeRental); // try moving the funtion itself outside of Getcurrentconditions and see if it still works
        let workersOnline = DataFromPool.workersOnline;
        let currentHashrate = DataFromPool.currentHashrate;
        let currentHashrateReadable = DataFromPool.currentHashrateReadable;
        let rewardsTotal = DataFromPool.rewardsTotal;
        let earnedRewards = DataFromPool.earnedRewards;
        let rewardsStillPending = DataFromPool.rewardsStillPending;
        let roundShares = DataFromPool.roundShares;
        let networkhashps = DataFromPool.networkhashps;
        let Networkhashrate = DataFromPool.Networkhashrate;
        let blockheight = DataFromPool.blockheight;
        let MinerSubStatusCode = DataFromPool.MinerSubStatusCode;
        let RewardsCompositeCode = DataFromPool.RewardsCompositeCode;
        let RoundSharesSubStatusCode = DataFromPool.RoundSharesSubStatusCode;
        let CandidateBlocksSubStatusCode = DataFromPool.CandidateBlocksSubStatusCode;
        let candidateheight = DataFromPool.candidateheight;
        let poolluck = DataFromPool.poolluck;
        let avgBlockTime = DataFromPool.avgBlockTime;
        let luck1024 = DataFromPool.luck1024;
        let luck256 = DataFromPool.luck256;
        let luck128 = DataFromPool.luck128;
        let luck64 = DataFromPool.luck64;
        let bestLuck = DataFromPool.bestLuck;
        let currentlyLucky = DataFromPool.currentlyLucky;
        let luckTrend = DataFromPool.luckTrend;
        let luck64rounded = Math.round((luck64)*1e2)/1e2
        let currentlyLuckyWords = (currentlyLucky) ? ('lucky') : ('not currently lucky')

        async function exchanges(token) {

          async function priceusdperbtconcoinbase() {
            return await new Promise((resolve, reject) => {
              https.get('https://api.coinbase.com/v2/exchange-rates?currency=BTC', (response) => {
                let body = ''
                response.on('data', (chunk) => {
                  body += chunk;
                });
                response.on('end', () => {
                  let data = JSON.parse(body);
                  if(!data) 
                    console.log('Something wrong with the api or syntax');
                  let PriceUsdPerBtcOnCoinbase = 
                    Math.round((data.data.rates.USD)*1e2)/1e2;
                  resolve(PriceUsdPerBtcOnCoinbase);
                });
              }).on("error", (error) => {
                console.log("Error: " + error.message);
                reject("Error: " + error.message)
              });
            });
          }

          async function priceperfloonbittrex() {
            return await new Promise((resolve, reject) => {
              https
                .get(
                  'https://api.bittrex.com/api/v1.1/public/getticker?market=BTC-FLO', 
                  (response) => {
                    let body = "";
                    response.on("data", (chunk) => {
                  body += chunk;
                });
                response.on('end', () => {
                  let data = JSON.parse(body)
                  if(!data) 
                    console.log('Something wrong with the api or syntax');
                  let bittrexMultiplier = 1
                  let PriceBtcPerTokenOnBittrex = 
                    Math.round((data.result.Last*bittrexMultiplier)*1e8)/1e8;
                  resolve(PriceBtcPerTokenOnBittrex);
                });
              }
            )
            .on("error", (error) => {
              console.log("Error: " + error.message);
              reject("Error: " + error.message)
            });
            });
          }

          async function priceperrvnonbittrex() {
            return await new Promise((resolve, reject) => {
              https
                .get(
                  'https://api.bittrex.com/v3/markets/RVN-BTC/ticker', 
                  (response) => {
                    let body = ''
                    response.on('data', (chunk) => {
                      body += chunk;
                    });
                    response.on('end', () => {
                      let data = JSON.parse(body)
                      if(!data) 
                        console.log('Something wrong with the api or syntax')
                      let bittrexMultiplier = 1
                      let PriceBtcPerTokenOnBittrex = 
                        Math.round((data.bidRate*bittrexMultiplier)*1e8)/1e8;
                      resolve(PriceBtcPerTokenOnBittrex);
                    })
                  }
                )
                .on("error", (error) => {
                  console.log("Error: " + error.message);
                  reject("Error: " + error.message)
                });
            });
          }

          async function priceusdperbtconbittrex() {
            return await new Promise((resolve, reject) => {
              https
                .get(
                  'https://api.bittrex.com/v3/markets/BTC-USD/ticker',
                  (response) => {
                    let body = ''
                    response.on('data', (chunk) => {
                      body += chunk;
                    });
                    response.on('end', () => {
                      let data = JSON.parse(body)
                      if(!data) 
                        console.log('Something wrong with the api or syntax');
                      let bittrexMultiplier = 1
                      let PriceUsdPerBtcOnBittrex = 
                        Math.round((data.bidRate*bittrexMultiplier)*1e2)/1e2;
                      resolve(PriceUsdPerBtcOnBittrex);
                    });
                  }
                )
                .on("error", (error) => {
                  console.log("Error: " + error.message);
                  reject("Error: " + error.message)
                })
            })
          }
        
          if (/RVN/.test(token)) {
            let TokenPair = 'BTC-RVN';
            let PriceUsdPerBtcOnCoinbase = await priceusdperbtconcoinbase();
            let PriceUsdPerBtcOnBittrex = await priceusdperbtconbittrex();
            let MarketPricePerTokenInBtc = await priceperrvnonbittrex();
            return {
              PriceUsdPerBtcOnCoinbase, 
              PriceUsdPerBtcOnBittrex, 
              TokenPair,
              MarketPricePerTokenInBtc
            };
            } else {
              if (/FLO/.test(token)) {
                let TokenPair = 'BTC-FLO';
                let PriceUsdPerBtcOnCoinbase = await priceusdperbtconcoinbase();
                let PriceBtcPerTokenOnBittrex = await priceperfloonbittrex();
                let PriceUsdPerBtcOnBittrex = await priceusdperbtconbittrex();
                let MarketPricePerTokenInBtc = PriceBtcPerTokenOnBittrex
                return {
                  PriceUsdPerBtcOnCoinbase, 
                  PriceUsdPerBtcOnBittrex,
                  TokenPair,
                  MarketPricePerTokenInBtc
              };
            }
          }  
        } 

        let Exchanges = await exchanges(token);
        let PriceUsdPerBtcOnCoinbase = Exchanges.PriceUsdPerBtcOnCoinbase;
        let PriceUsdPerBtcOnBittrex = Exchanges.PriceUsdPerBtcOnBittrex;
        let MarketPriceUsdPerBtc = Math.round((PriceUsdPerBtcOnCoinbase + PriceUsdPerBtcOnBittrex)/2*1e2)/1e2
        let TokenPair = Exchanges.TokenPair;
        let MarketPricePerTokenInBtc = Exchanges.MarketPricePerTokenInBtc;
        let MaxPercentFromAvailRigs = (marketpreferenceKawpow === 'EU') ? (totalSpeedKawpowEU * 1 / Networkhashrate) : (totalSpeedKawpowUSA / Networkhashrate)
        // let MaxPercentFromAvailBal = UsersBalance / (UsersBalance + (minDuration * PriceRentalStandard/24 * Networkhashrate))
        let MaxPercent = Math.min(MaxPercentFromAvailRigs, .99)

        async function calculations(Networkhashrate, PriceRentalStandard, MarketPricePerTokenInBtc, tokensPerBlock, blocksPerHour) {
          let HourlyMiningCostInBtc = Math.round((Networkhashrate * PriceRentalStandard / 24)*1e6)/1e6;
          let HourlyMiningValueInBtc = Math.round(blocksPerHour * tokensPerBlock * MarketPricePerTokenInBtc * 1e6)/ 1e6;
          return { HourlyMiningValueInBtc, HourlyMiningCostInBtc};
        }

        let Calculations = await calculations(Networkhashrate, PriceRentalStandard, MarketPricePerTokenInBtc, tokensPerBlock, blocksPerHour);
        let HourlyMiningCostInBtc = Calculations.HourlyMiningCostInBtc;
        let HourlyMiningValueInBtc = Calculations.HourlyMiningValueInBtc;

        async function minimums(token, tokenAlgo, Networkhashrate, marketFactor, networkhashps, PriceRentalStandard, PriceUsdPerBtcOnCoinbase, HourlyMiningValueInBtc, HourlyMiningCostInBtc, minDuration) {
          let BittrexWithdrawalFee = 0.00005;
          let BittrexMinWithdrawal = 0.00015;
          let nicehashMinRentalCost = 0.005;
          let MinPercentFromNHMinAmount = Math.round((nicehashMinRentalCost / (((Networkhashrate * PriceRentalStandard) / 24) * minDuration + nicehashMinRentalCost)) * 1e6 ) / 1e6;

          async function MinPercentFromNHMinLimitCalc(props) {
            async function MinPercentFromNHMinLimitKawpow(props) {
              let Networkhashrate = networkhashps / marketFactor
              let MinPercentFromNHMinLimitRvn = Math.round((0.1 / (Networkhashrate + 0.1)) * 1e8) / 1e8;
              return MinPercentFromNHMinLimitRvn;
            }

            async function MinPercentFromNHMinLimitScrypt(props) {
              let Networkhashrate = networkhashps / marketFactor
              let MinPercentFromNHMinLimitScrypt = Math.round((0.01 / (Networkhashrate + 0.01)) * 1e8) / 1e8;
                return MinPercentFromNHMinLimitScrypt
            }

            if (/RVN/.test(token)) {
              let MinPercentFromNHMinLimit =  await MinPercentFromNHMinLimitKawpow();
              return {MinPercentFromNHMinLimit};
            } else {
              if (/FLO/.test(token)) {
                let MinPercentFromNHMinLimit = await MinPercentFromNHMinLimitScrypt();
                return {MinPercentFromNHMinLimit};
              }
            }
            return {MinPercentFromNHMinLimit};
          }

          let MinPercentFromNHMinLimitLoad = await MinPercentFromNHMinLimitCalc();
          let MinPercentFromNHMinLimit = MinPercentFromNHMinLimitLoad.MinPercentFromNHMinLimit;
          let minMargin = 0
          let MinPercentFromBittrexMinWithdrawal = Math.round((BittrexMinWithdrawal / (BittrexMinWithdrawal + Networkhashrate * PriceRentalStandard * minDuration)) * 1e6) / 1e6;
          
          let MinimumMinimum = Math.min(
            MinPercentFromNHMinAmount,
            MinPercentFromNHMinLimit,
            MinPercentFromBittrexMinWithdrawal
          );
          let HighestMinimum = Math.max(
            MinPercentFromNHMinAmount,
            MinPercentFromNHMinLimit,
            MinPercentFromBittrexMinWithdrawal
            )
          return {
            MinPercentFromNHMinAmount,
            MinPercentFromNHMinLimit,
            MinPercentFromBittrexMinWithdrawal,
            HighestMinimum
          };
        }

        let Minimums = await minimums(token, tokenAlgo, Networkhashrate, marketFactor, networkhashps, PriceRentalStandard, PriceUsdPerBtcOnCoinbase, HourlyMiningValueInBtc, HourlyMiningCostInBtc, minDuration);
        let MinPercentFromNHMinAmount = Minimums.MinPercentFromNHMinAmount;
        let MinPercentFromNHMinLimit = Minimums.MinPercentFromNHMinLimit;
        let MinPercentFromBittrexMinWithdrawal = Minimums.MinPercentFromBittrexMinWithdrawal;
        let HighestMinimum = Minimums.HighestMinimum
        let suggestedMinRentalDuration = Math.round((6 / (myPoolShare/100 * blocksPerHour / luck64))*1e3)/1e3

        return {UsersBalance, PriceRentalStandard, marketFactor, MarketFactorName, workersOnline, currentHashrate, currentHashrateReadable, rewardsTotal,
          earnedRewards, rewardsStillPending, roundShares, networkhashps, Networkhashrate, blockheight, MinerSubStatusCode, RewardsCompositeCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode,
          candidateheight, poolluck, avgBlockTime, PriceUsdPerBtcOnCoinbase, PriceUsdPerBtcOnBittrex, MarketPriceUsdPerBtc, TokenPair, MarketPricePerTokenInBtc, MaxPercent, HourlyMiningCostInBtc, HourlyMiningValueInBtc, 
          MinPercentFromNHMinAmount, MinPercentFromNHMinLimit, MinPercentFromBittrexMinWithdrawal, HighestMinimum, leadingMinerShare, myPoolShare, poolDominanceMultiplier, secondPlaceMinerShare, 
          luck1024, luck256, luck128, luck64, bestLuck, currentlyLucky, luckTrend, luck64rounded, currentlyLuckyWords, marketpreferenceKawpow, suggestedMinRentalDuration}

      }catch(error){
        console.log('provider is down, error:', error)
        let RentalCompositeStatusCode = 9
        let PriceRentalStandard = null;
        let marketFactor = null
        let MarketFactorName = null
        return {RentalCompositeStatusCode, PriceRentalStandard, marketFactor, MarketFactorName, BotStatusCode}
      }      
    }
// RentalCompositeStatusCodeOverride
    async function getcurrentrental(CurrentConditions) {
      let RewardsCompositeCode = CurrentConditions.RewardsCompositeCode;
      let MinerSubStatusCode = CurrentConditions.MinerSubStatusCode;
      // console.log('RewardsCompositeCode:', RewardsCompositeCode, 'MinerSubStatusCode:', MinerSubStatusCode)
      let marketpreferenceKawpow = CurrentConditions.marketpreferenceKawpow;
      if (MinerSubStatusCode === 9) {
          RentalCompositeStatusCode = 8
          RewardsCompositeCode = 9
          return {RentalCompositeStatusCode, RewardsCompositeCode}
        }
        else{
          let RentalOrders = await provider.provider.getOrders({
              algo: "KAWPOW",
              mk: `${marketpreferenceKawpow}`,
            });
          if (RentalOrders === undefined){
            if (MinerSubStatusCode === 4) {
              let RentalCompositeStatusCode = 7
              let rentalOrderId = null
              let rentalOrderIdReadable = null
              let rentalDuration = null
              let rentalPercentComplete = null
              let estTimeRemainingInSec = null
              let estTimeRemainingInHours = null
              let estTimeRemainingInRoundHours = null
              let estTimeRemainingRMins = null
              let estTimeRemainingInRoundMins = null
              let estTimeRemainingRSecs = null
              let estTimeRemainingInMs = null
              let actualNetworkPercent = null
              let PayedAmount = null
              let CostOfRentalInBtc = null
              let StopMonitoringForRewardsLimit = null
              let CostOfRentalInUsd = null
              let AvailableAmount = null
            return {RentalCompositeStatusCode, RewardsCompositeCode, RentalOrders, rentalOrderId, rentalOrderIdReadable, estTimeRemainingInSec, estTimeRemainingInMs, estTimeRemainingInHours, estTimeRemainingInRoundHours,estTimeRemainingRMins, estTimeRemainingInRoundMins,estTimeRemainingRSecs, PayedAmount, CostOfRentalInBtc, CostOfRentalInUsd, AvailableAmount, rentalPercentComplete, rentalDuration, actualNetworkPercent, StopMonitoringForRewardsLimit}  
            }
            else{
              let RentalCompositeStatusCode = 9
              RewardsCompositeCode = 8
              let rentalOrderId = null
              let rentalOrderIdReadable = null
              let rentalDuration = null
              let rentalPercentComplete = null
              let estTimeRemainingInSec = null
              let estTimeRemainingInHours = null
              let estTimeRemainingInRoundHours = null
              let estTimeRemainingRMins = null
              let estTimeRemainingInRoundMins = null
              let estTimeRemainingRSecs = null
              let estTimeRemainingInMs = null
              let actualNetworkPercent = null
              let PayedAmount = null
              let CostOfRentalInBtc = null
              let StopMonitoringForRewardsLimit = null
              let CostOfRentalInUsd = null
              let AvailableAmount = null
            return {RentalCompositeStatusCode, RewardsCompositeCode, RentalOrders, rentalOrderId, rentalOrderIdReadable, estTimeRemainingInSec, estTimeRemainingInMs, estTimeRemainingInHours, estTimeRemainingInRoundHours,estTimeRemainingRMins, estTimeRemainingInRoundMins,estTimeRemainingRSecs, PayedAmount, CostOfRentalInBtc, CostOfRentalInUsd, AvailableAmount, rentalPercentComplete, rentalDuration, actualNetworkPercent, StopMonitoringForRewardsLimit}  
            
            }
            
          }
            
          try{
            const rentalOrderId = RentalOrders.id
            let RentalStatus = RentalOrders.status.code

            let CostOfRentalInBtc = (RentalStatus === 'CANCELLED') ? (parseFloat (RentalOrders.payedAmount)) : (parseFloat(RentalOrders.amount))
            let PayedAmount = Math.min((parseFloat(RentalOrders.payedAmount) + (CostOfRentalInBtc * 0.03) + 0.0001), CostOfRentalInBtc)
            let EndingSoonAmount = 0.80 * CostOfRentalInBtc
            let NotStartedYetAmount = 0.05 * CostOfRentalInBtc
            
            let RentalEndTime = Date.parse(RentalOrders.endTs)
            let CurrentTime = new Date().getTime();
            let TimeSinceRentalEnded = CurrentTime - RentalEndTime
            let StopMonitoringForRewardsLimit = 25 * 60 * 1000 // 25 minutes
            let RentalCompositeStatusCode;
            // console.log('RentalStatus:', RentalStatus)
            if (RentalStatus === 'CANCELLED'){
              RentalCompositeStatusCode = (TimeSinceRentalEnded < StopMonitoringForRewardsLimit)?(3):(0)
            } else if (RentalStatus === 'COMPLETED'){
              RentalCompositeStatusCode = (TimeSinceRentalEnded < StopMonitoringForRewardsLimit)?(3):(0)
            } else if (RentalStatus === 'ACTIVE'){
              if (MinerSubStatusCode === 0){
                RentalCompositeStatusCode = 5
              } else if (MinerSubStatusCode === 1){
                RentalCompositeStatusCode = (PayedAmount < EndingSoonAmount) ? (1) : (2) 
              } else if (MinerSubStatusCode === 2){
                RentalCompositeStatusCode = 4
              } else if (MinerSubStatusCode === 3){
                RentalCompositeStatusCode = 5
              } else if (MinerSubStatusCode === 4){
                RentalCompositeStatusCode = 5
              } else {
                RentalCompositeStatusCode = 9
              }
            } else if (RentalStatus === 'DEAD'){
              RentalCompositeStatusCode = (TimeSinceRentalEnded < StopMonitoringForRewardsLimit)?(4):(0)
            } else {
              RentalCompositeStatusCode = 9
            }
            // console.log('RentalCompositeStatusCode:', RentalCompositeStatusCode)
            const rentalOrderIdReadable = rentalOrderId.substr(0,7)
            let rentalDuration = Math.round((RentalOrders.amount / (RentalOrders.price * RentalOrders.limit) * 24 )* 1e2)/1e2;
            let rentalPercentComplete = (PayedAmount / CostOfRentalInBtc)
            let estTimeRemainingInSec = RentalOrders.estimateDurationInSeconds
            let estTimeRemainingInHours = estTimeRemainingInSec / (60*60)
            let estTimeRemainingInRoundHours = Math.floor(estTimeRemainingInHours)
            let estTimeRemainingRMins = (estTimeRemainingInSec / 60)-(60*estTimeRemainingInRoundHours)
            let estTimeRemainingInRoundMins = (Math.floor(estTimeRemainingRMins)<10) ? (("0" + Math.floor(estTimeRemainingRMins)).slice(-2)) : (Math.floor(estTimeRemainingRMins))
            let estTimeRemainingRSecs = (Math.floor(estTimeRemainingInSec - (60*estTimeRemainingInRoundMins) - (60*60*estTimeRemainingInRoundHours))<10) ? (("0" + (Math.floor(estTimeRemainingInSec - (60*estTimeRemainingInRoundMins) - (60*60*estTimeRemainingInRoundHours)))).slice(-2)) : Math.floor(estTimeRemainingInSec - (60*estTimeRemainingInRoundMins) - (60*60*estTimeRemainingInRoundHours))  
            let estTimeRemainingInMs = estTimeRemainingInSec * 1000
            let actualNetworkPercent = RentalOrders.limit / CurrentConditions.Networkhashrate
            let CostOfRentalInUsd = Math.round(CostOfRentalInBtc * CurrentConditions.MarketPriceUsdPerBtc * 1e2) / 1e2;
            let AvailableAmount = CostOfRentalInBtc - PayedAmount
            return {RentalCompositeStatusCode, RewardsCompositeCode, RentalOrders, rentalOrderId, rentalOrderIdReadable, estTimeRemainingInSec, estTimeRemainingInMs, estTimeRemainingInHours, estTimeRemainingInRoundHours,estTimeRemainingRMins, estTimeRemainingInRoundMins,estTimeRemainingRSecs, PayedAmount, CostOfRentalInBtc, CostOfRentalInUsd, AvailableAmount, rentalPercentComplete, rentalDuration, actualNetworkPercent, StopMonitoringForRewardsLimit}  
          }catch(error){
            console.log('error 3321', error)
            let RentalCompositeStatusCode = 9
            let rentalOrderId = null
            let RewardsCompositeCode = 8
            let rentalOrderIdReadable = null
            let rentalDuration = null
            let rentalPercentComplete = null
            let estTimeRemainingInSec = null
            let estTimeRemainingInHours = null
            let estTimeRemainingInRoundHours = null
            let estTimeRemainingRMins = null
            let estTimeRemainingInRoundMins = null
            let estTimeRemainingRSecs = null
            let estTimeRemainingInMs = null
            let actualNetworkPercent = null
            let CostOfRentalInUsd = null
            let AvailableAmount = null
            return {RentalCompositeStatusCode, RewardsCompositeCode, RentalOrders, rentalOrderId, rentalOrderIdReadable, estTimeRemainingInSec, estTimeRemainingInMs, estTimeRemainingInHours, estTimeRemainingInRoundHours,estTimeRemainingRMins, estTimeRemainingInRoundMins,estTimeRemainingRSecs, PayedAmount, CostOfRentalInBtc, CostOfRentalInUsd, AvailableAmount, rentalPercentComplete, rentalDuration, actualNetworkPercent, StopMonitoringForRewardsLimit}  
          }
        }
    }   

    async function bestarbitragecurrentconditions(item, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions) {
   
      var BestValues = new Array();
      var ArbOpSize = new Array();  //ArbOpSizeByMargin
      var ArbOpSizeByProfitUsd = new Array();  
      var TryTheseForNetworkPercent = new Array(); 
      var ListCostOfRentalInUsd = new Array(); 
      var Rent = new Array(); //ListHashrateToRent
      var Price = new Array(); //ListRentalPrices
      var ListCostOfRentalInBtc = new Array(); 
      var ListEstTokensMined = new Array();
      var ListEstProfitBtc = new Array();
      var ListEstValue = new Array();
      var ListEstValueUsd = new Array();
      var AboveMinsList = new Array();
      var ExpectedPoolDominanceMultiplierList = new Array();
      let MaxPercentAsInt = CurrentConditions.MaxPercent * 1000
      var listOfNetworkPercentValuesToTry = [];
      for (var i = 1; i <= MaxPercentAsInt; i++) {
      listOfNetworkPercentValuesToTry.push(i/1000);
      }
      listOfNetworkPercentValuesToTry.forEach(tryListOfNetworkPercentValues);
      
      async function tryListOfNetworkPercentValues(item, index) {
        let AlwaysMineModeEstimates = await alwaysminemodeestimates(
          CurrentConditions.MinPercentFromNHMinAmount, 
          CurrentConditions.MinPercentFromNHMinLimit, 
          CurrentConditions.MinPercentFromBittrexMinWithdrawal,
          CurrentConditions.HighestMinimum, 
          item, 
          UserInput.minMargin, 
          blocksPerHour, 
          tokensPerBlock, 
          CurrentConditions.Networkhashrate, 
          CurrentConditions.poolDominanceMultiplier,
          CurrentConditions.myPoolShare, 
          CurrentConditions.secondPlaceMinerShare,
          CurrentConditions.suggestedMinRentalDuration,
          CurrentConditions.PriceUsdPerBtcOnBittrex, 
          CurrentConditions.MarketPricePerTokenInBtc, 
          CurrentConditions.MarketFactorName, 
          CurrentConditions.PriceRentalStandard,
          CurrentConditions.luck64)
        
        let ArbSize = AlwaysMineModeEstimates.SpartanMerchantArbitragePrcnt
        let Profit = AlwaysMineModeEstimates.ProfitUsd
        let NetworkPercent = Math.floor((AlwaysMineModeEstimates.NetworkPercent)*1e4)/1e4
        let CostOfRentalInUsdAtTheseVars = AlwaysMineModeEstimates.CostOfRentalInUsd
        let RentTheseVars = AlwaysMineModeEstimates.Rent
        let PriceTheseVars = AlwaysMineModeEstimates.price
        let EstimatedCostOfRentalInBtcTheseVars = AlwaysMineModeEstimates.EstCostOfRentalInBtc
        let ListEstTokensMinedTheseVars = AlwaysMineModeEstimates.EstimatedQtyOfTokensToBeMined
        let ProfitAtMarketPriceBtcTheseVars = AlwaysMineModeEstimates.ProfitAtMarketPriceBtc
        let ListEstValueTheseVars = AlwaysMineModeEstimates.ValueOfEstTokensAtMarketPrice
        let ListEstValueUsdTheseVars = AlwaysMineModeEstimates.ValueOfEstTokensAtMktPriceUsd
        let ExpectedPoolDominanceMultiplierTheseVars = AlwaysMineModeEstimates.ExpectedPoolDominanceMultiplier
        let lowestArb = -10
        let AboveMinimums = (CurrentConditions.HighestMinimum < item) 
        let AboveMinsTheseVars = AboveMinimums
        if (CurrentConditions.HighestMinimum < item) {
          if (lowestArb < ArbSize){
            ArbOpSize.push(ArbSize)
            ArbOpSizeByProfitUsd.push(Profit)
            TryTheseForNetworkPercent.push(NetworkPercent)
            ListCostOfRentalInUsd.push(CostOfRentalInUsdAtTheseVars)
            Rent.push(RentTheseVars)
            Price.push(PriceTheseVars)
            ListCostOfRentalInBtc.push(EstimatedCostOfRentalInBtcTheseVars)
            ListEstTokensMined.push(ListEstTokensMinedTheseVars)
            ListEstProfitBtc.push(ProfitAtMarketPriceBtcTheseVars)
            ListEstValue.push(ListEstValueTheseVars)
            ListEstValueUsd.push(ListEstValueUsdTheseVars)
            AboveMinsList.push(AboveMinsTheseVars)
            ExpectedPoolDominanceMultiplierList.push(ExpectedPoolDominanceMultiplierTheseVars)
            let bestArbOpportunityByProfit = Math.max(...ArbOpSizeByProfitUsd)
            
            function indexMatchProfit(element, index, array){
              return (element === bestArbOpportunityByProfit)
            }

            let indexMatchProfitValue = ArbOpSizeByProfitUsd.findIndex(indexMatchProfit)
            let bestArbOpportunityByProfitMargin = ArbOpSize[indexMatchProfitValue]
            let bestPercentByProfit = TryTheseForNetworkPercent[indexMatchProfitValue]
            let bestCostUsdByProfit = ListCostOfRentalInUsd[indexMatchProfitValue]
            let bestRentByProfit = Rent[indexMatchProfitValue]
            let bestPriceByProfit = Price[indexMatchProfitValue]
            let CostOfRentalInBtcValueByProfit = ListCostOfRentalInBtc[indexMatchProfitValue]
            let EstimatedQtyOfTokensToBeMinedByProfit = ListEstTokensMined[indexMatchProfitValue]
            let ProfitAtMarketPriceBtcByProfit = ListEstProfitBtc[indexMatchProfitValue]
            let EstimatedValueOfMiningByProfit = ListEstValue[indexMatchProfitValue]
            let EstimatedValueOfMiningInUsdByProfit = ListEstValueUsd[indexMatchProfitValue]
            let ExpectedPoolDominanceMultiplierByProfile = ExpectedPoolDominanceMultiplierList[indexMatchProfitValue]
        
            BestValues.push(
              'best profit(USD):', //-26
              bestArbOpportunityByProfit, //-25
              'margin(%):', //-24
              bestArbOpportunityByProfitMargin, //-23 
              'Network Percent:', //-22
              bestPercentByProfit, //-21
              'Est Value(BTC):',
              EstimatedValueOfMiningByProfit, //-19
              'Est Value(USD):',//-18
              EstimatedValueOfMiningInUsdByProfit, //-17
              'Cost(BTC):',//-16
              CostOfRentalInBtcValueByProfit, //-15
              'Profit(BTC):', //-14
              ProfitAtMarketPriceBtcByProfit, //-13
              'Cost(USD):', //-12
              bestCostUsdByProfit, //-11
              'Hashrate:', //-10
              bestRentByProfit, //-9
              'Hash-Price:', //-8
              bestPriceByProfit, //-7
              'Duration:', //-6
              CurrentConditions.suggestedMinRentalDuration, //-5
              'Est Qty:', //-4
              EstimatedQtyOfTokensToBeMinedByProfit, //-3
              'Est Dominance Mult', //-2
              ExpectedPoolDominanceMultiplierByProfile //-1
              )
          }
        }
        let bestProfit = BestValues.length - 25
        return BestValues
      }
      let Values = await tryListOfNetworkPercentValues()
      let ProjectedProfitInUsd = Math.floor((Values[Values.length - 25])*1e2)/1e2;
      let ProjectedProfitMargin = Math.floor((Values[Values.length - 23])*1e2)/1e2;
      let HashrateToRent = Values[Values.length - 9];
      let MarketFactorName = CurrentConditions.MarketFactorName;
      let RentalDuration = Values[Values.length - 5];
      let RentalHashPrice = Values[Values.length - 7];
      let ProjectedTokenRewards = Values[Values.length - 3];
      let CostOfRentalInBtc = Values[Values.length - 15];
      let CostOfRentalInUsd = Values[Values.length - 11];
      let ProjectedRevenueInBtc = Values[Values.length - 19];
      let ProjectedRevenueInUsd = Values[Values.length - 17];
      let NetworkPercentToRent = Values[Values.length - 21];
      let ExpectedPoolDominanceMultiplier = Values[Values.length - 1];

      return {ProjectedProfitInUsd, ProjectedProfitInUsd, ProjectedProfitMargin, HashrateToRent, MarketFactorName, RentalDuration, RentalHashPrice, ProjectedTokenRewards, CostOfRentalInBtc, CostOfRentalInUsd, ProjectedRevenueInBtc, ProjectedRevenueInUsd, NetworkPercentToRent, ExpectedPoolDominanceMultiplier}
      
      return Values
    };

    // this one estimates the value of mining while rentals are running 
    async function liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart) {
      let BittrexWithdrawalFee = 0.00005;
      let BittrexMinWithdrawal = 0.00015;
      let nicehashMinRentalCost = 0.005;
      let actualNetworkPercent = CurrentRental.actualNetworkPercent
      // console.log('RentalCompositeStatusCode:', CurrentRental.RentalCompositeStatusCode)
      let RentalStatus = (CurrentRental.RentalCompositeStatusCode === 7) ? ('NEWACCOUNT') : ((CurrentRental.RentalCompositeStatusCode === 9)?('UNKNOWN'):(CurrentRental.RentalOrders.status.code))

      let CostOfRentalInBtc = (RentalStatus === 'UNKNOWN')?(0):((RentalStatus === 'NEWACCOUNT')?(0):((RentalStatus ==='CANCELLED') ? (parseFloat(CurrentRental.RentalOrders.PayedAmount)) : (parseFloat(CurrentRental.RentalOrders.amount))))
      let CostOfRentalInUsd = CurrentRental.CostOfRentalInUsd;
      let myExpectedPoolShare = CurrentConditions.myPoolShare + CurrentRental.actualNetworkPercent
      let rentalPercentComplete = Math.round((CurrentRental.rentalPercentComplete)*1e3)/1e3;
      let rentalDuration = CurrentRental.rentalDuration;
      let rewardsTotal = CurrentConditions.rewardsTotal;
      let minedTokens = Math.round((rewardsTotal - rewardsBeforeRentalStart)*1e3)/1e3; 
      
      let LiveEstimateQtyOfTokensToBeMined = (Math.round((minedTokens / rentalPercentComplete)*1e3)/1e3);
      
      let EstimatedQtyOfTokensToBeMined = Math.round(CurrentRental.actualNetworkPercent * tokensPerBlock * blocksPerHour * rentalDuration * CurrentConditions.poolDominanceMultiplier * 1e5) / 1e5;
      let ValueOfEstTokensAtMarketPrice = Math.round(((LiveEstimateQtyOfTokensToBeMined * CurrentConditions.MarketPricePerTokenInBtc * 0.998)) * 1e8) / 1e8;
      let ValueOfEstTokensAtMktPriceUsd = Math.round(ValueOfEstTokensAtMarketPrice * CurrentConditions.MarketPriceUsdPerBtc * 1e2) / 1e2;
      let minMargin = UserInput.minMargin
      let tokens = (LiveEstimateQtyOfTokensToBeMined > 0) ? (LiveEstimateQtyOfTokensToBeMined) : (EstimatedQtyOfTokensToBeMined)
      let TargetOfferPricePerMinedToken = Math.round(Math.max((((CostOfRentalInBtc + BittrexWithdrawalFee) * (1 + minMargin)) / tokens), CurrentConditions.MarketPricePerTokenInBtc) * 1e8) / 1e8;
      let MarketVsOfferSpread = Math.round(((CurrentConditions.MarketPricePerTokenInBtc - TargetOfferPricePerMinedToken) / Math.max(TargetOfferPricePerMinedToken, CurrentConditions.MarketPricePerTokenInBtc)) *1e2) / 1e2;
      let ValueOfEstTokensAtTargetOffer = (LiveEstimateQtyOfTokensToBeMined > 0) ? (Math.round(((TargetOfferPricePerMinedToken * LiveEstimateQtyOfTokensToBeMined) - BittrexWithdrawalFee) * 1e8) / 1e8) : (0);
      let ValueOfEstTokensAtTgtOfferUsd = Math.round(ValueOfEstTokensAtTargetOffer * CurrentConditions.MarketPriceUsdPerBtc * 1e2) /1e2;
      let ProfitUsd = Math.round((ValueOfEstTokensAtMktPriceUsd - (CurrentRental.CostOfRentalInUsd + (CurrentConditions.MarketPricePerTokenInBtc * BittrexWithdrawalFee))) * 1e2) / 1e2;
      let Margin = Math.round((ProfitUsd/ValueOfEstTokensAtMktPriceUsd)*1e4)/1e4
      let ProfitAtMarketPriceUsd = Math.round((ValueOfEstTokensAtTgtOfferUsd - (CurrentRental.CostOfRentalInUsd + (BittrexWithdrawalFee * CurrentConditions.MarketPriceUsdPerBtc))) * 1e2) / 1e2;
      let SpartanMerchantArbitragePrcnt = (ValueOfEstTokensAtMarketPrice >= CostOfRentalInBtc) ? (Math.round( ((ValueOfEstTokensAtMarketPrice - CostOfRentalInBtc - BittrexWithdrawalFee) / CostOfRentalInBtc + BittrexWithdrawalFee) * 1e3 ) / 1e3) : ((ValueOfEstTokensAtMarketPrice/CostOfRentalInBtc)-1)
      
      return {
        actualNetworkPercent, 
        rentalDuration, 
        CostOfRentalInBtc,
        rewardsTotal,
        minedTokens,
        LiveEstimateQtyOfTokensToBeMined,
        EstimatedQtyOfTokensToBeMined,
        rentalPercentComplete,
        TargetOfferPricePerMinedToken,
        MarketVsOfferSpread,
        ValueOfEstTokensAtMarketPrice,
        ValueOfEstTokensAtTargetOffer,
        CostOfRentalInUsd,
        ValueOfEstTokensAtTgtOfferUsd,
        ValueOfEstTokensAtMktPriceUsd,
        ProfitUsd,
        Margin,
        ProfitAtMarketPriceUsd,
        SpartanMerchantArbitragePrcnt
      };
    }

    //rename this - this estimates the value of mining while no rentals are active
    async function alwaysminemodeestimates(MinPercentFromNHMinAmount, MinPercentFromNHMinLimit, MinPercentFromBittrexMinWithdrawal, HighestMinimum, item, UsersRequestedMargin, blocksPerHour, tokensPerBlock, Networkhashrate, poolDominanceMultiplier,myPoolShare, secondPlaceMinerShare, suggestedMinRentalDuration, PriceUsdPerBtcOnBittrex, MarketPricePerTokenInBtc, MarketFactorName, PriceRentalStandard, luck64) {

      let NetworkPercent = (item === undefined) ? (CurrentConditions.MaxPercent) : item
      let BittrexWithdrawalFee = 0.00005;
      let BittrexMinWithdrawal = 0.00015;
      let nicehashMinRentalCost = 0.005;
      let profileMinDuration = suggestedMinRentalDuration;
      let duration = suggestedMinRentalDuration;
      let MarketPriceUsdPerBtc = PriceUsdPerBtcOnBittrex; //Coinbase.priceUsdPerBtc
      let Rent = Math.round( Networkhashrate * (-NetworkPercent / (-1 + NetworkPercent)) * 1e1 ) / 1e1;
      let EstCostOfRentalInBtc = Math.round( ((Rent * duration) / 24) * PriceRentalStandard * 1e8 ) / 1e8;
      let CostOfRentalInUsd = Math.round((EstCostOfRentalInBtc * PriceUsdPerBtcOnBittrex)*1e2)/1e2
      let myExpectedPoolShare = myPoolShare + NetworkPercent
      let ExpectedPoolDominanceMultiplier = Math.round(((Math.pow((myPoolShare/secondPlaceMinerShare),1.01)+4)/5)*1e2)/1e2
      let luck64rounded = (luck64 === undefined) ? (1) : Math.round((luck64)*1e2)/1e2
      let EstimatedQtyOfTokensToBeMinedIgnoringLuck = Math.round((NetworkPercent * tokensPerBlock * blocksPerHour * duration * ExpectedPoolDominanceMultiplier) * 1e5) / 1e5;
      let EstimatedQtyOfTokensToBeMined = Math.round((EstimatedQtyOfTokensToBeMinedIgnoringLuck / luck64rounded) * 1e0) / 1e0;
      let ValueOfEstTokensAtMarketPrice = Math.round( ((EstimatedQtyOfTokensToBeMined * MarketPricePerTokenInBtc) ) * 1e8 ) / 1e8;
      let ValueOfEstTokensAtMktPriceUsd = Math.round(ValueOfEstTokensAtMarketPrice * MarketPriceUsdPerBtc * 1e2) / 1e2;
      let TargetOfferPricePerMinedToken = Math.round( Math.max( ((EstCostOfRentalInBtc + BittrexWithdrawalFee) * (1 + UsersRequestedMargin)) / EstimatedQtyOfTokensToBeMined, MarketPricePerTokenInBtc ) * 1e8 ) / 1e8;
      let MarketVsOfferSpread = Math.round( ((MarketPricePerTokenInBtc - TargetOfferPricePerMinedToken) / Math.max(TargetOfferPricePerMinedToken, MarketPricePerTokenInBtc)) * 1e2 ) / 1e2;
      let ValueOfEstTokensAtTargetOffer = Math.round( ((TargetOfferPricePerMinedToken * EstimatedQtyOfTokensToBeMined) - BittrexWithdrawalFee) * 1e8 ) / 1e8;
      let ValueOfEstTokensAtTgtOfferUsd = Math.round(ValueOfEstTokensAtTargetOffer * MarketPriceUsdPerBtc * 1e2) / 1e2;
      let ProfitUsd = Math.round((ValueOfEstTokensAtMktPriceUsd - (CostOfRentalInUsd + (PriceUsdPerBtcOnBittrex * BittrexWithdrawalFee))) * 1e2) / 1e2;
      let SpartanMerchantArbitragePrcnt = (ValueOfEstTokensAtMarketPrice >= EstCostOfRentalInBtc) ? (Math.round( ((ValueOfEstTokensAtMarketPrice - EstCostOfRentalInBtc - BittrexWithdrawalFee) / EstCostOfRentalInBtc + BittrexWithdrawalFee) * 1e3 ) / 1e3) : ((ValueOfEstTokensAtMarketPrice/EstCostOfRentalInBtc)-1)
      let hashrate = Rent;
      let amount = EstCostOfRentalInBtc;
      let price = PriceRentalStandard;

      return {
        MinPercentFromNHMinAmount,
        MinPercentFromNHMinLimit,
        MinPercentFromBittrexMinWithdrawal,
        HighestMinimum,
        Rent,
        amount,
        price,
        duration,
        duration,
        NetworkPercent,
        Rent,
        MarketFactorName,
        poolDominanceMultiplier,
        EstimatedQtyOfTokensToBeMined,
        MarketPricePerTokenInBtc,
        TargetOfferPricePerMinedToken,
        MarketVsOfferSpread,
        EstCostOfRentalInBtc,
        ValueOfEstTokensAtMarketPrice,
        ValueOfEstTokensAtTargetOffer,
        CostOfRentalInUsd,
        ValueOfEstTokensAtTgtOfferUsd,
        ValueOfEstTokensAtMktPriceUsd,
        ProfitUsd,
        SpartanMerchantArbitragePrcnt,
        UsersRequestedMargin, 
        ExpectedPoolDominanceMultiplier
      };
    }

    async function beforerentalsleep(ms, SpartanBotCompositeStatusCode, CurrentConditions) {
      // console.log('1  running function beforerentalsleep', SpartanBotCompositeStatusCode)
      return new Promise(resolve => setTimeout(resolve,ms));
    }

    async function duringrentalsleep(ms, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental) {
      return new Promise(resolve => setTimeout(resolve,ms));
    }
    
    async function afterrentalsleep(ms, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental) {
      return new Promise(resolve => setTimeout(resolve,ms, CurrentRental));
    }

    async function botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, minMargin) {
      let RentalEndTime = (CurrentRental.RentalCompositeStatusCode >= 7)?(0):(Date.parse(CurrentRental.RentalOrders.endTs))
      let CurrentTime = new Date().getTime();
      let TimeSinceRentalEnded = CurrentTime - RentalEndTime
      let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
      // console.log(RentalCompositeStatusCode, RewardsCompositeCode, MinerSubStatusCode)

      try{
        let UsersRequestedMargin = UserInput.minMargin 
        let currentlyProfitable = (LiveEstimatesFromMining === undefined) ? (false) : (LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt > 0)
        let currentlyAboveUsersMinMargin = (LiveEstimatesFromMining === undefined) ? (false) : (LiveEstimatesFromMining.SpartanMerchantArbitragePrcnt > UserInput.minMargin)
        while (RentalCompositeStatusCode === 0) { // no rental
          let projectedProfitable = (BestArbitrageCurrentConditions === undefined) ? (false) : (BestArbitrageCurrentConditions.ProjectedProfitMargin > 0)
          let projectedAboveUsersMinMargin = (BestArbitrageCurrentConditions === undefined) ? (false) : (BestArbitrageCurrentConditions.ProjectedProfitMargin > minMargin)    
          let BotStatusCode = (projectedProfitable) ? ( (projectedAboveUsersMinMargin) ? (1):(2)) : (3)  
          // let RentalEndTime = Date.parse(CurrentRental.RentalOrders.endTs)
          // let CurrentTime = new Date().getTime();
          // let TimeSinceRentalEnded = CurrentTime - RentalEndTime
          // let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
          // // let BotStatusCode = (RewardsCompositeCode === 1) ? ((projectedProfitable)?((projectedAboveUsersMinMargin)?(1):(2)):(3)) : ((RewardsCompositeCode === 0)?((StopMonitoringForRewardsLimit < TimeSinceRentalEnded)?(6):((projectedProfitable)?((projectedAboveUsersMinMargin)?(1):(2)):(3))):('error'))

          return {BotStatusCode, projectedProfitable, projectedAboveUsersMinMargin}
        }
        while (RentalCompositeStatusCode > 0) { // something other than no rental
          while (RentalCompositeStatusCode > 3) { // RentalCompositeStatusCode is 4 or above, Dead or Down
            while (RentalCompositeStatusCode === 7) {
              let projectedProfitable = (BestArbitrageCurrentConditions === undefined) ? (false) : (BestArbitrageCurrentConditions.ProjectedProfitMargin > 0)
              let projectedAboveUsersMinMargin = (BestArbitrageCurrentConditions === undefined) ? (false) : (BestArbitrageCurrentConditions.ProjectedProfitMargin > minMargin)    
              let BotStatusCode = (projectedProfitable) ? ( (projectedAboveUsersMinMargin) ? (1):(2)) : (3)
              return {BotStatusCode, projectedProfitable, projectedAboveUsersMinMargin}   
            }
            while (RentalCompositeStatusCode > 7) { //RentalCompositeStatusCode is 8 or 9, something is down
              let BotStatusCode = (RentalCompositeStatusCode === 8) ? (9) : (8)
              return {BotStatusCode, RewardsCompositeCode , currentlyProfitable, currentlyAboveUsersMinMargin, RentalEndTime, StopMonitoringForRewardsLimit}
            }
            while (RentalCompositeStatusCode === 4) { //RentalCompositeStatusCode is 4, Dead Order
              let BotStatusCode = (RewardsCompositeCode === 1) ? (1) : ((RewardsCompositeCode === 0) ? ( (currentlyProfitable)?(2):(3) ) : ('error 2') )
              return {BotStatusCode, RewardsCompositeCode , currentlyProfitable, currentlyAboveUsersMinMargin, RentalEndTime, StopMonitoringForRewardsLimit}
            }
            while (RentalCompositeStatusCode === 5) { //RentalCompositeStatusCode is 5, Order Not Yet Alive
              let BotStatusCode = (RewardsCompositeCode === 0) ? (4) : ('error 3')
              return {BotStatusCode, RewardsCompositeCode , currentlyProfitable, currentlyAboveUsersMinMargin, RentalEndTime, StopMonitoringForRewardsLimit}
            }
          }
          while (RentalCompositeStatusCode < 3) { //RentalCompositeStatusCode is 1 or 2, its minining
            let RewardsCompositeCode = CurrentConditions.RewardsCompositeCode
            let BotStatusCode = (currentlyProfitable === undefined)?(3):((currentlyProfitable)?((currentlyAboveUsersMinMargin)?(1):(2)):(3))
            let RentalEndTime = Date.parse(CurrentRental.RentalOrders.endTs) 
            let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
            return {BotStatusCode, RewardsCompositeCode, currentlyProfitable, currentlyAboveUsersMinMargin, RentalEndTime, StopMonitoringForRewardsLimit}
          }
          while (RentalCompositeStatusCode === 3) { // Rental recently finished
            let RewardsCompositeCode = CurrentConditions.RewardsCompositeCode
            let projectedProfitable = (BestArbitrageCurrentConditions === undefined) ? (false) : (BestArbitrageCurrentConditions.ProjectedProfitMargin > 0)
            let projectedAboveUsersMinMargin = (BestArbitrageCurrentConditions === undefined) ? (false) : (BestArbitrageCurrentConditions.ProjectedProfitMargin > minMargin)
            // let RentalEndTime = Date.parse(CurrentRental.RentalOrders.endTs)
            // let CurrentTime = new Date().getTime();
            // let TimeSinceRentalEnded = CurrentTime - RentalEndTime
            // let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
            let BotStatusCode = (RewardsCompositeCode === 1) ? ((currentlyProfitable)?((currentlyAboveUsersMinMargin)?(1):(2)):(3)) : ((RewardsCompositeCode === 0)?((StopMonitoringForRewardsLimit < TimeSinceRentalEnded)?(6):((currentlyProfitable)?((currentlyAboveUsersMinMargin)?(1):(2)):(3))):('error'))
            return {BotStatusCode, RewardsCompositeCode , currentlyProfitable, currentlyAboveUsersMinMargin, RentalEndTime, StopMonitoringForRewardsLimit}
          }
        }
      }catch(error){
        console.log('error 344', error)
        let BotStatusCode = 9
        return {BotStatusCode}
      }
    } //end of botstatus function
    
    let UserInput = userinput();
    let token = UserInput.token;
    let tokenAlgo = UserInput.tokenAlgo;
    let minDuration = UserInput.minDuration;
    const tokensPerBlock = (UserInput.token === 'RVN') ? (5000) : (UserInput.token === 'FLO') ? (3.125) : (null)
    const blocksPerHour = (UserInput.token === 'RVN') ? (60) : (UserInput.token === 'FLO') ? (90) : (null)
    let CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    let NetworkPercent;
    let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)

    let MinerSubStatusCode = (CurrentConditions === undefined) ? (9) : (CurrentConditions.MinerSubStatusCode)
    let CandidateBlocksSubStatusCode = (CurrentConditions === undefined) ? (9) : (CurrentConditions.CandidateBlocksSubStatusCode)
    let RoundSharesSubStatusCode = (CurrentConditions === undefined) ? (9) : (CurrentConditions.RoundSharesSubStatusCode)
    let RewardsCompositeCode = (CurrentConditions === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
  
    let rewardsBeforeRentalStart = CurrentConditions.rewardsTotal // turn off if something is interupted mid cycle
    // let rewardsBeforeRentalStart = 90556.983; // turn on if something is interupted mid cycle

    let CurrentRental = await getcurrentrental(CurrentConditions)
    let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)

    // let RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    // let RewardsCompositeCode = CurrentConditions.RewardsCompositeCode
    // let BotStatus;
    // let RentalCompositeStatusCodeOverride;
    
    // let BotStatusCode;
    let RentalCompositeStatusCode = (CurrentRental === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
    // console.log('RentalCompositeStatusCode:', RentalCompositeStatusCode)
    let BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    let BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
    // console.log('BotStatusCode:', BotStatusCode)
    let SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
    // console.log('SpartanBotCompositeStatusCode:', SpartanBotCompositeStatusCode)
    // let SpartanBotCompositeStatusCode;
    // let BestArbitrageCurrentConditions;
     // = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
    // let LiveEstimatesFromMining;

    // if (RentalCompositeStatusCode >= 1) {
    //   LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
    // }  
    // let BestArbitrageCurrentConditions;
    




// move everything into the parts that are exclusive to that RentalCompositeStatusCode (after the higher number while '}' )

while (RentalCompositeStatusCode >= 0) {
  rewardsBeforeRentalStart = CurrentConditions.rewardsTotal // turn off if something is interupted mid cycle
  // rewardsBeforeRentalStart = 90556.983; // turn on if something is interupted mid cycle
  while (RentalCompositeStatusCode >= 1) {
    // console.log('While RentalCompositeStatusCode >= 1; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)

    while (RentalCompositeStatusCode >=2) {
      // console.log('While RentalCompositeStatusCode >= 2; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)

      while (RentalCompositeStatusCode >= 3) {
        
        while (RentalCompositeStatusCode >= 4) {
          while (RentalCompositeStatusCode >= 5) {
            while (RentalCompositeStatusCode > 5) {
              while (RentalCompositeStatusCode === 7){
                let sleeptime = 30 * 1000
                CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
                RewardsCompositeCode = (CurrentConditions === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
                CurrentRental = await getcurrentrental(CurrentConditions)
                let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
                let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
                BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
                let RentalEndTime = BotStatus.RentalEndTime;
                let CurrentTime = new Date().getTime();
                let TimeSinceRentalEnded = CurrentTime - RentalEndTime
                let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit

                RentalCompositeStatusCode = (CurrentRental === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
                BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
                
                SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
                
                console.log('While RentalCompositeStatusCode = 7; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, SpartanBotCompositeStatusCode)

                output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
                await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, RentalCompositeStatusCode)  
              }
              while (RentalCompositeStatusCode === 9){
                let sleeptime = 30 * 1000
                CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
                RewardsCompositeCode = (CurrentConditions === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
                CurrentRental = await getcurrentrental(CurrentConditions)
                let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
                let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
                BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
                let RentalEndTime = BotStatus.RentalEndTime;
                let CurrentTime = new Date().getTime();
                let TimeSinceRentalEnded = CurrentTime - RentalEndTime
                let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit

                RentalCompositeStatusCode = (CurrentRental === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
                BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
                
                SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
                
                console.log('While RentalCompositeStatusCode = 9; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, SpartanBotCompositeStatusCode)

                output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
                await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, RentalCompositeStatusCode)  
              
              }
              //error state (above 5)
              let sleeptime = 30 * 1000
              console.log('While RentalCompositeStatusCode = 5; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)
              output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
              await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)

            } // only 5

            CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
            CurrentRental = await getcurrentrental(CurrentConditions)
            let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
            let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
            BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
            let RentalEndTime = BotStatus.RentalEndTime;
            let CurrentTime = new Date().getTime();
            let TimeSinceRentalEnded = CurrentTime - RentalEndTime
            let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit

            RentalCompositeStatusCode = (RentalCompositeStatusCode === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
            BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
            RewardsCompositeCode = (RewardsCompositeCode === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
            SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
            let sleeptime = 30 * 1000
            console.log('While RentalCompositeStatusCode = 5; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)
            output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
            await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)

          } // only 4
        } // only 3

        CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
        CurrentRental = await getcurrentrental(CurrentConditions)
        let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
        let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
        BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
        let RentalEndTime = BotStatus.RentalEndTime;
        let CurrentTime = new Date().getTime();
        let TimeSinceRentalEnded = CurrentTime - RentalEndTime
        let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit

        RentalCompositeStatusCode = (RentalCompositeStatusCode === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
        BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
        RewardsCompositeCode = (RewardsCompositeCode === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
        SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
        
        console.log('While RentalCompositeStatusCode = 3; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)

        // let CurrentTime = new Date().getTime();
        // let RentalEndTime = CurrentRental.RentalEndTime;
        // let TimeSinceRentalEnded = CurrentTime - RentalEndTime
        // let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
        

        let sleeptime = 30 * 1000
        if (SpartanBotCompositeStatusCode === "306") {            
            let sleeptime = 15 * 1000
            // let CurrentTime = new Date().getTime();
            // let RentalEndTime = BotStatus.RentalEndTime;
            // let TimeSinceRentalEnded = CurrentTime - RentalEndTime
            // let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
            console.log('While SpartanBotCompositeStatusCode is 306; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit)
            output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
            await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
            BotStatus = await botstatus(0, 0, CurrentConditions, CurrentRental, LiveEstimatesFromMining, 0, 0, 0, BestArbitrageCurrentConditions, UserInput.minMargin)
            RentalEndTime = BotStatus.RentalEndTime
            BotStatusCode = BotStatus.BotStatusCode
            RentalCompositeStatusCode = 0
            RewardsCompositeCode = 0
            SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
            console.log('While SpartanBotCompositeStatusCode is 306; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit)
            output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode, RewardsCompositeCode)
            CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
            CurrentRental = await getcurrentrental(CurrentConditions)
            RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
            SpartanBotCompositeStatusCode = (RentalCompositeStatusCode === 0) ? (306) : ("" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode)
            await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
          } else {
            output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
            await afterrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
          }
      } // only 2

      CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
      CurrentRental = await getcurrentrental(CurrentConditions)
      let BestArbitrageCurrentConditions;
       // = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
      let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
      RentalCompositeStatusCode = (RentalCompositeStatusCode === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
      RewardsCompositeCode = (RewardsCompositeCode === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
      
      BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
      BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
        
      SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
    
      let RentalEndTime = BotStatus.RentalEndTime;
      let CurrentTime = new Date().getTime();
      let TimeSinceRentalEnded = CurrentTime - RentalEndTime
      let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
      
      let sleeptime = 30 * 1000
      // let RentalEndTime = BotStatus.RentalEndTime;
      // let CurrentTime = new Date().getTime();
      // let TimeSinceRentalEnded = CurrentTime - RentalEndTime
      // let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
      console.log('While RentalCompositeStatusCode <= 2; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)
      
      output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
      await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
    
      
    } // only 1
    CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    CurrentRental = await getcurrentrental(CurrentConditions)
    let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
    let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
    
    RentalCompositeStatusCode = (RentalCompositeStatusCode === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
    RewardsCompositeCode = (CurrentConditions.RewardsCompositeCode === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
        
    BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
    SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
    
    let RentalEndTime = BotStatus.RentalEndTime;
    let CurrentTime = new Date().getTime();
    let TimeSinceRentalEnded = CurrentTime - RentalEndTime
    let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
    console.log('While RentalCompositeStatusCode <= 1; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)

    let sleeptime = 30 * 1000
    output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
    
  } // only 0

  // let sleeptime = 15 * 1000
  //           console.log('While SpartanBotCompositeStatusCode is 306; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit)
  //           output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
  //           await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
  //           BotStatus = await botstatus(0, 0, CurrentConditions, CurrentRental, LiveEstimatesFromMining, 0, 0, 0, BestArbitrageCurrentConditions, UserInput.minMargin)
  //           RentalEndTime = BotStatus.RentalEndTime
  //           BotStatusCode = BotStatus.BotStatusCode
  //           RentalCompositeStatusCode = 0
  //           RewardsCompositeCode = 0
  //           SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
  //           console.log('While SpartanBotCompositeStatusCode is 306; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit)
  //           output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode, RewardsCompositeCode)
  //           CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
  //           CurrentRental = await getcurrentrental(CurrentConditions)
  //           RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
  //           SpartanBotCompositeStatusCode = (RentalCompositeStatusCode === 0) ? (306) : ("" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode)
  //           await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)



  console.log('While RentalCompositeStatusCode >= 0; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, RentalCompositeStatusCode)

  CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
  RewardsCompositeCode = (CurrentConditions === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
  CurrentRental = await getcurrentrental(CurrentConditions)
  let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions)
  let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
  BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
  let RentalEndTime = BotStatus.RentalEndTime;
  let CurrentTime = new Date().getTime();
  let TimeSinceRentalEnded = CurrentTime - RentalEndTime
  let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit

  RentalCompositeStatusCode = (CurrentRental === undefined) ? (9) : (CurrentRental.RentalCompositeStatusCode)
  BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
  
  SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
  

  // console.log('While RentalCompositeStatusCode >= 0; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)

  let sleeptime = 15 * 1000
  output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
  if (RentalCompositeStatusCode === 0) {
    await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, RentalCompositeStatusCode)
    output(CurrentConditions, CurrentRental, UserInput.token, '306', BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, RentalCompositeStatusCode)
  } else
  await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, RentalCompositeStatusCode)
            
                
}









    // while (RentalCompositeStatusCode < 8) { // this runs for all non-error codes      
    //   CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    //   CurrentRental = await getcurrentrental(CurrentConditions)
    //   let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions);
    //   let LiveEstimatesFromMining;
    //   BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
                
                          
    //   while (RentalCompositeStatusCode <= 4) { // this runs for all 4 and below

    //     while (RentalCompositeStatusCode <= 3) { //this runs for all 3 and below

    //       while (RentalCompositeStatusCode <= 2) { // this runs for all 2 and below

    //         while (RentalCompositeStatusCode <= 1) { // this runs for all 1 and 0

    //           while (RentalCompositeStatusCode <= 0) { // this runs for 0 only
                
    //             rewardsBeforeRentalStart = CurrentConditions.rewardsTotal // turn off if something is interupted mid cycle
    //             // rewardsBeforeRentalStart = 34198.95600; // turn on if something is interupted mid cycle

    //             // let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions);
    //             // let LiveEstimatesFromMining;
    //             let sleeptime = 60 * 1000
    //             // BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
                
    //             RentalCompositeStatusCode = (RentalCompositeStatusCode === undefined) ? (9) ? (CurrentRental.RentalCompositeStatusCode)
    //             BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
    //             RewardsCompositeCode = (RewardsCompositeCode === undefined) ? (9) : (CurrentConditions.RewardsCompositeCode)
    //             SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode

    //             // console.log('While RentalCompositeStatusCode <= 0; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3)
    //             output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    //             await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, RentalCompositeStatusCode)
    //             CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    //             CurrentRental = await getcurrentrental(CurrentConditions)
    //             RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    //             RewardsCompositeCode = CurrentConditions.RewardsCompositeCode
    //           } // this is only run for 1
    //           CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    //           CurrentRental = await getcurrentrental(CurrentConditions)
    //           RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    //           let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
    //           let BestArbitrageCurrentConditions;
    //           BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    //           BotStatusCode = (BotStatus === undefined) ? (9) : (BotStatus.BotStatusCode)
    //           SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + CurrentConditions.RewardsCompositeCode + BotStatusCode
    //           // console.log('While RentalCompositeStatusCode <= 1; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3)
    //           let sleeptime = 60 * 1000
    //           output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    //           await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
    //         } // this is only run for 2
    //         CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    //         CurrentRental = await getcurrentrental(CurrentConditions)
    //         let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
    //         let BestArbitrageCurrentConditions;
    //         BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    //         BotStatusCode = BotStatus.BotStatusCode
    //         RentalCompositeStatusCode = (CurrentRental.rentalPercentComplete < 1) ? (2) : (3)
    //         SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + CurrentConditions.RewardsCompositeCode + BotStatusCode
    //         // console.log('While RentalCompositeStatusCode <= 2; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3)
    //         let sleeptime = 30 * 1000
    //         output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    //           await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
            
    //       } // this is only run for 3
    //       CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    //       CurrentRental = await getcurrentrental(CurrentConditions)
    //       let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart)
    //       RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    //       RewardsCompositeCode = CurrentRental.RewardsCompositeCode
    //       let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions);
    //       BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    //       BotStatusCode = BotStatus.BotStatusCode
    //       let RentalEndTime = BotStatus.RentalEndTime;
    //       let CurrentTime = new Date().getTime();
    //       let TimeSinceRentalEnded = CurrentTime - RentalEndTime
    //       let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
    //       SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
    //       // console.log('While RentalCompositeStatusCode <= 3; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit, SpartanBotCompositeStatusCode)
    //       let sleeptime = 60 * 1000
    //       if (SpartanBotCompositeStatusCode === "306") {            
    //         let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart);
    //         let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions);
    //         CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    //         CurrentRental = await getcurrentrental(CurrentConditions)
    //         RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    //         RewardsCompositeCode = CurrentRental.RewardsCompositeCode
    //         BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    //         BotStatusCode = BotStatus.BotStatusCode
    //         SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
    //         let RentalEndTime = BotStatus.RentalEndTime;
    //         let CurrentTime = new Date().getTime();
    //         let TimeSinceRentalEnded = CurrentTime - RentalEndTime
    //         let StopMonitoringForRewardsLimit = CurrentRental.StopMonitoringForRewardsLimit
    //         output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)

    //         BotStatus = await botstatus(0, 0, CurrentConditions, CurrentRental, LiveEstimatesFromMining, 0, 0, 0, BestArbitrageCurrentConditions, UserInput.minMargin)
    //         BotStatusCode = BotStatus.BotStatusCode
    //         RentalCompositeStatusCode = 0
    //         RewardsCompositeCode = 0
    //         SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode
    //         output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)

    //         RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    //         // console.log('While SpartanBotCompositeStatusCode is 306; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, 'rental ended at:', RentalEndTime, 'current time:', CurrentTime, 'difference:', TimeSinceRentalEnded, 'limit:', StopMonitoringForRewardsLimit)
    //         SpartanBotCompositeStatusCode = (RentalCompositeStatusCode === 0) ? (306) : ("" + RentalCompositeStatusCode + RewardsCompositeCode + BotStatusCode)
    //         await beforerentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
    //       } else {
    //         output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    //         await afterrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
    //       }
    //     } // this is only run for 4 - think about if this also needs a RentalCompositeStatusCodeOverride
    //     RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    //     let BestArbitrageCurrentConditions;
    //     let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart);
      
    //     BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    //     BotStatusCode = BotStatus.BotStatusCode
    //     SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + CurrentConditions.RewardsCompositeCode + BotStatusCode
    //     // console.log('While RentalCompositeStatusCode <= 4; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3)
    //     let sleeptime = 60 * 1000
    //     output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    //     await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
    //   } // this is only run for 5
    //   // CurrentConditions = await getcurrentconditions(UserInput.token, UserInput.tokenAlgo, UserInput.minDuration, tokensPerBlock, blocksPerHour)
    //   // CurrentRental = await getcurrentrental(CurrentConditions, RentalCompositeStatusCodeOverride)
    //   RentalCompositeStatusCode = CurrentRental.RentalCompositeStatusCode
    //   // let LiveEstimatesFromMining = await liveestimatesfrommining(CurrentRental, CurrentConditions, UserInput, tokensPerBlock, blocksPerHour, rewardsBeforeRentalStart);
    //   // let BestArbitrageCurrentConditions = await bestarbitragecurrentconditions(NetworkPercent, UserInput, tokensPerBlock, blocksPerHour, CurrentConditions);
    //   // BotStatus = await botstatus(RentalCompositeStatusCode, RewardsCompositeCode, CurrentConditions, CurrentRental, LiveEstimatesFromMining, MinerSubStatusCode, RoundSharesSubStatusCode, CandidateBlocksSubStatusCode, BestArbitrageCurrentConditions, UserInput.minMargin)
    //   BotStatusCode = BotStatus.BotStatusCode
    //   SpartanBotCompositeStatusCode = "" + RentalCompositeStatusCode + CurrentConditions.RewardsCompositeCode + BotStatusCode
    //   // console.log('While RentalCompositeStatusCode <= 5; rewardsBeforeRentalStart:', Math.round((rewardsBeforeRentalStart)*1e3)/1e3, SpartanBotCompositeStatusCode)
    //   let sleeptime = 60 * 1000
    //   output(CurrentConditions, CurrentRental, UserInput.token, SpartanBotCompositeStatusCode, BestArbitrageCurrentConditions, LiveEstimatesFromMining, sleeptime, BotStatusCode)
    //   await duringrentalsleep(sleeptime, SpartanBotCompositeStatusCode, CurrentConditions, CurrentRental, RentalCompositeStatusCode)
    // }

}).catch(err => console.log('err', err))

export default SpartanBot
