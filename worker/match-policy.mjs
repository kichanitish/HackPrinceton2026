export const MATCH_REPLIES={
 uninterpretable_preferences:'I couldn’t reliably interpret those preferences. Please try a shorter apartment-search request with your budget, room needs and preferred location. Your shortlist hasn’t changed.',
 out_of_scope:'I can help you find and compare apartment rentals in Houston and Los Angeles. That request is outside what HomeFit can help with. Tell me your rent budget, room needs or preferred location, and I’ll help narrow your search.',
 property_type:'HomeFit currently covers apartment rentals, not detached houses or homes for sale. Would you like to look for an apartment instead? Please update your request if so.',
 unsupported_city:'HomeFit currently has listings in Houston and Los Angeles. Please choose one of those areas; I don’t want to suggest properties somewhere you haven’t asked to live.',
 travel_time:'I can check a straight-line distance from a place, but I can’t verify driving distances or travel times with the current tools. What straight-line radius in miles would work for you?',
 ambiguous:'I found more than one possible place. Which one did you mean?',
 location_unavailable:'I couldn’t verify that location. Please add its full name and city, a street address, or a ZIP code. I haven’t changed your shortlist.',
 missing_radius:'How many miles from that place would you like to search? I can check a straight-line radius, rather than driving distance.',
 unsupported_requirement:'I can verify rent, room counts, reported area, pet and parking records, and straight-line distance. I can’t verify that additional requirement from this catalog. Please describe which of those available facts I should prioritize instead.',
 conflicting_needs:'Some of those requirements conflict. Please clarify the room counts, budget or location you want me to use. Your shortlist hasn’t changed.',
 per_person_budget:'The catalog lists rent for the whole apartment. What is your total monthly apartment rent budget, before fees?',
 transaction:'HomeFit can help compare apartment rentals and explore their scans, but can’t submit applications, make payments or book tours. Tell me what you’re looking for and I can help you shortlist options.'
};
export function matchReply(code,extra={}){return {ok:true,status:code==='out_of_scope'?'out_of_scope':'clarification',code,message:MATCH_REPLIES[code]||MATCH_REPLIES.conflicting_needs,matches:[],...extra}}
export function obviousMatchIssue(text){
 if(/\b(?:detached|single[- ]family|standalone)\s+(?:house|home)|\b(?:buy|purchase)\s+(?:a |an |the )?(?:house|home|apartment|condo)\b/i.test(text))return 'property_type';
 if(/\b(?:within|under|less than|max(?:imum)?)\s+\d+\s*(?:min(?:ute)?s?|hours?)\b|\b(?:driving|walking|transit|by car)\s+(?:distance|time|miles)\b/i.test(text))return 'travel_time';
 if(/\b(?:write|compose|generate)\b.{0,40}\b(?:poem|song|code|recipe|essay)|\b(?:weather forecast|solve this equation|stock picks|book (?:a )?flight)\b/i.test(text))return 'out_of_scope';
 return null;
}
