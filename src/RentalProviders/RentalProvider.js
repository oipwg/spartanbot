import uid from 'uid'

/**
 * A Single Rental Provider API wrapper (to standardize between multiple providers)
 */
class RentalProvider {
	/**
	 * Create a new Rental Provider
	 * @param  {Object} settings - Settings for the RentalProvider
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
	 * @param {String} settings.name - Alias/arbitrary name for the provider
	 * @param {Array.<Object>} settings.pools - Array of pools (pool profiles for MRR)
	 * @param {String} [settings.uid] - The unique identifier for this Rental Provider
	 * @return {RentalProvider} 
	 */
	constructor(settings = {}){
		this.uid = settings.uid || uid()
		this.api_key = settings.api_key
		this.api_secret = settings.api_secret
		this.name = settings.name
		this.pools = []
		this.activePoolID = undefined
		this.activeRigs = []
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "RentalProvider"
	 * @static
	 */
	static getType(){
		return "RentalProvider"
	}

	getUID(){
		return this.uid
	}

	/**
	 * Test to make sure the API key and secret are correct
	 * @return {Promise} Returns a Promise that will resolve upon success, and reject on failure
	 */
	async testAuthorization(){
		return true
	}

	/**
	 * Add pools to local variable this.pools
	 * @param pools
	 */
	addPools(pools) {
		if (Array.isArray(pools)) {
			for (let pool of pools) {
				this.pools.push(pool)
			}
		} else
			this.pools.push(pools)
	}

	/**
	 * Set pools to local variable this.pools (rewrite the variable)
	 * @param pools
	 */
	setPools(pools) {
		this.pools = pools
	}

	/**
	 * Fetch this.pools
	 * @returns {Array<Object>|*}
	 */
	getPools() {
		return this.pools
	}

	/**
	 * Set pool id to be the active pool ID for a provider (pool profile id for MRR)
	 * @param {number|string} id - pool id (pool profile id for MRR)
	 */
	setActivePoolID(id) {
		let setID = id
		if (typeof setID === 'string') {
			setID = Number(setID);
		} else if (typeof setID !== 'number') {
			return 'Error: ID must be of type string or number'
		}
		this.activePoolID = setID
	}

	/**
	 * Get pool id (pool profile id for MRR)
	 * @returns {number}
	 */
	getActivePoolID() {
		return this.activePoolID
	}

	/**
	 * Get current balance
 	 * @param {string} [coin] - coin to fetch the balance for
	 * @returns {Promise<number>}
	 */
	async getBalance(coin) {
		try {
			return await this._getBalance();
		} catch (err) {
			throw new Error(`Error fetching balance \n ${err}`)
		}
	}

	/**
	 * Fetch balance for all available coins
	 * @returns {Promise<Object>}
	 */
	async getBalances() {
		try {
			return await this._getBalances();
		} catch (err) {
			throw new Error(`Error fetching balances \n ${err}`)
		}
	}

	/**
	 * Add rig(s) to the existing array of active rigs IDs
	 * @param {Object|Array.<Object>} rigIDs - ID of an active rig
	 * @returns {Object} - returns an object with a success failure if the passed in arg is not an Object or an Array
	 */
	addActiveRigs(rigIDs) {
		if (Array.isArray(rigIDs)) {
			for (let id of rigIDs) {
				this.activeRigs.push(id)
			}
		} else if (typeof rigIDs === 'object' && rigIDs !== null) {
			this.activeRigs.push(rigIDs)
		} else {
			return {success: false, message: 'Rigs must be an object or an array'}
		}
		return {success: true, message: 'successfully added rigs', activeRigs: this.activeRigs}
	}

	/**
	 * Fetch current list of active rigs
	 * @returns {Array}
	 */
	getActiveRigs() {
		return this.activeRigs
	}

	/**
	 * setActiveRigs overwrites the local variable array. Use only on construct.
	 * @param {Object|Array.<Object>} rigs - A rig object or an array of rig objects (note: rig/rental interchangeable)
	 * @returns {{success: boolean, message: string}} - Returns an object if the passed in arg is not correct type
	 */
	setActiveRigs(rigs) {
		if (Array.isArray(rigs)) {
			this.activeRigs = rigs
		} else if (typeof rigs === 'object' && rigs !== null) {
			this.activeRigs = [rigs]
		} else {
			return {success: false, message: 'Rigs must be an object or an array'}
		}
	}

	/**
	 * Fetch active rigs - calls the child class' _fetchActiveRigs function
	 * @returns {Promise<Array.<number>>} - returns an array of rig ids
	 */
	async fetchActiveRigs() {
		try {
			return await this._fetchActiveRigs()
		} catch (err) {
			throw new Error(err)
		}
	}

	/**
	 * Fetches active rigs and stores them in the local variable this.activeRigs
	 * @returns {Promise<boolean>} - returns true if store successful, false if not
	 */
	async storeActiveRigs() {
		let rigs;
		try {
			rigs = await this.fetchActiveRigs()
			this.setActiveRigs(rigs)
		} catch (err) {
			throw new Error('Failed to set Current Rentals \n ${err')
		}
		return this.activeRigs === rigs;
	}

	/**
	 * Get back a "Serialized" state of the Provider
	 * @return {Object} Returns a JSON object that contains the current rental provider state
	 */
	serialize(){
		return {
			type: "RentalProvider",
			api_key: this.api_key,
			api_secret: this.api_secret,
			uid: this.uid,
			pools: this.pools,
			activePoolID: this.activePoolID,
			activeRigs: this.activeRigs
		}
	}
}

export default RentalProvider