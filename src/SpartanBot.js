/**
 * Rent hashrate based on a set of circumstances
 */
class SpartanBot {
	/**
	 * [constructor description]
	 * @param  {[type]} options [description]
	 * @return {[type]}         [description]
	 */
	constructor(options){

	}
	
	/**
	 * Run a Manual Rental instruction
	 * @param  {Number} hashrate - The hashrate you wish to rent (in MegaHash)
	 * @param  {Number} duration - The number of seconds that you wish to rent the miners for
	 * @param  {Function} [confirmation] - Pass in a function that returns a Promise to offer confirmation to the user
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object that contains information about the rental request
	 */
	async manualRental(hashrate, duration, confirmation){
		let waitFn = async () => {
			setTimeout(() => { return }, 1000)
		}

		await waitFn()

		// Check if the user wants to proceed with the purchase
		if (confirmation){
			let confirmed = false

			try {
				confirmed = await confirmation({
					total_cost: 25.31,
					total_hashrate: 2513
				})
			} catch (e) {}

			if (!confirmed){
				return {
					success: false,
					info: "Manual Rental Cancelled"
				}
			}
		}

		await waitFn()

		return {
			success: true,
			info: "Successfully rented miners"
		}		
	}
}

export default SpartanBot