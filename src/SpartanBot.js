import { Account } from 'oip-account'
import uid from 'uid';

import { MRRProvider, NiceHashProvider } from './RentalProviders'
import AutoRenter from './AutoRenter'

const SUPPORTED_RENTAL_PROVIDERS = [ MRRProvider, NiceHashProvider ]

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

		this.rental_providers = []

		// Try to load state from LocalStorage if we are not memory only
		if (!this.settings.memory){

			this._deserialize = this.deserialize().then(() => {
				//check first to see if a mnemonic was passed in and load the wallet from there
				if (this.settings.mnemonic) {
					this.wallet = new Account(settings.mnemonic, undefined, {discover: false})
					this._wallet_login = this.wallet.login()

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
		} else if (settings.type === "NiceHash") {
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
	 * @return {Promise}
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
		this.returnPools()
	}

	/**
	 * Delete a pool
	 * @param {(number|string)} id - Pool id
	 * @returns {Promise<*>}
	 */
	async deletePool(id) {
		let poolDelete = []
		for (let p of this.getRentalProviders()) {
			try {
				poolDelete.push(await p.deletePool(id))
			} catch (err) {
				throw new Error(err)
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
			throw new Error('Cannot get pools: no providers setup')
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
	 * Run a Manual Rental instruction
	 * @param  {Number} hashrate - The hashrate you wish to rent (in MegaHash)
	 * @param  {Number} duration - The number of seconds that you wish to rent the miners for
	 * @param  {Function} [confirmation] - Pass in a function that returns a Promise to offer confirmation to the user
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object that contains information about the rental request
	 */
	async manualRental(hashrate, duration, confirmation){
		this.autorenter = new AutoRenter({
			rental_providers: this.rental_providers
		})

		try {
			let rental_info = await this.autorenter.rent({
				hashrate,
				duration,
				confirm: confirmation
			})

			return rental_info
		} catch (e) {
			throw new Error("Unable to rent using SpartanBot!\n" + e)
		}
	}

	/**
	 * Serialize all information about SpartanBot to LocalStorage (save the current state)
	 * @return {Boolean} Returns true if successful
	 * @private
	 */
	serialize(){
		let serialized = {
			rental_providers: []
		}

		serialized.settings = this.settings

		for (let provider of this.rental_providers){
			serialized.rental_providers.push(provider.serialize())
		}

		serialized.oip_account = this.oip_account

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
			this.settings = {...data_from_storage.settings, ... this.settings}

		if (data_from_storage.rental_providers){
			for (let provider of data_from_storage.rental_providers){
				await this.setupRentalProvider(provider)
			}
		}

		if (data_from_storage.oip_account){
			this.oip_account = data_from_storage.oip_account
		}

		return true
	}
}

export default SpartanBot